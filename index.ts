// index.ts
import { parse as parseEnv } from "https://deno.land/std@0.115.1/flags/mod.ts";

import { ApolloServer } from "npm:apollo-server-express";
import { stitchSchemas } from "npm:@graphql-tools/stitch";
import { buildSubgraphSchema } from "npm:@apollo/subgraph";
import express from "npm:express";
import {
  parse,
  buildSchema,
  buildASTSchema,
  GraphQLScalarType,
  Kind,
  GraphQLObjectType,
  execute,
  subscribe,
  GraphQLSchema,
  GraphQLFieldResolver,
  GraphQLUnionType,
  GraphQLInterfaceType,
  GraphQLTypeResolver,
} from "npm:graphql";
import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
  ApolloServerPluginLandingPageGraphQLPlayground,
  ApolloServerPluginDrainHttpServer,
} from "npm:apollo-server-core";
import { PubSub } from "npm:graphql-subscriptions";
import { equal } from "https://deno.land/x/equal@v1.5.0/mod.ts";
import { createServer } from "node:http";
import { SubscriptionServer } from "npm:subscriptions-transport-ws";
import { makeExecutableSchema } from "npm:@graphql-tools/schema";
import { buildFederatedSchema } from "npm:@apollo/federation";

const args = parseEnv(Deno.args, {
  alias: {
    schema: ["s"],
    queries: ["q"],
    port: ["p"],
  },
  default: {
    schema: "schema.graphqls",
    queries: "queries.json",
    port: 4000,
  },
});

// Read the schema string
const schemaPath = resolvePath(Deno.cwd(), args.schema);
const schemaString = readFileSync(schemaPath, "utf8");

// Parse the schema string into a DocumentNode
const parsedTypeDefs = parse(schemaString);

// Prepare resolvers
let resolvers: Record<string, any> = {};

// Create a PubSub instance
const pubsub = new PubSub();

// Create a shared global state object
let globalState: any = {};

// Variables to hold the current schema and subscription server
let schema: GraphQLSchema;
let subscriptionServer: SubscriptionServer | null = null;

// Initialize Apollo Server
let apolloServer: ApolloServer | null = null;

// Define interfaces for type safety
interface QueriesConfig {
  init?: string;
  queries: QueryEntry[];
  resolveReferences?: ResolveReferenceEntry[];
}

interface QueryEntry {
  type: string; // 'Query', 'Mutation', 'Subscription', or other type names
  field: string;
  parameters?: any;
  tsScript?: string;
  return?: any;
  publish?: PublishAction[];
  schedule?: {
    interval: number;
  };
}

interface ResolveReferenceEntry {
  type: string; // The entity type name
  tsScript: string;
}

interface PublishAction {
  subscription: string;
  payload: Record<string, any>;
}

/**
 * Adds __typename to the returned data based on the GraphQL return type.
 * @param value The returned data.
 * @param returnType The GraphQL return type.
 * @returns The data with __typename added.
 */
function addTypename(value: any, returnType: any): any {
  if (value == null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => addTypename(item, returnType.ofType || returnType));
  }

  if (typeof value === 'object') {
    const typeName = returnType.name || (returnType.ofType && returnType.ofType.name);
    if (typeName && !value.__typename) {
      value.__typename = typeName;
    }

    // Recursively add __typename to nested objects
    const fields = returnType.getFields ? returnType.getFields() : null;
    if (fields) {
      for (const key in value) {
        if (value.hasOwnProperty(key) && fields[key]) {
          const fieldType = fields[key].type;
          value[key] = addTypename(value[key], fieldType);
        }
      }
    }

    return value;
  }

  return value;
}


/**
 * Loads queries from the queries.json file.
 * @returns The parsed queries configuration.
 */
async function loadQueries(): Promise<{
  queriesConfig: QueriesConfig;
  queryEntries: QueryEntry[];
  resolveReferenceEntries: ResolveReferenceEntry[];
}> {
  const queriesPath = resolvePath(Deno.cwd(), args.queries);
  const queriesData = readFileSync(queriesPath, "utf8");
  const queriesConfig: QueriesConfig = JSON.parse(queriesData);
  const queryEntries = queriesConfig.queries || []; // Get the 'queries' array
  const resolveReferenceEntries = queriesConfig.resolveReferences || [];
  console.log('Loaded resolveReferenceEntries:', resolveReferenceEntries);
  return { queriesConfig, queryEntries, resolveReferenceEntries };
}

/**
 * Executes the initialization script specified in the queries configuration.
 * @param queriesConfig The queries configuration object.
 */
async function executeInitScript(queriesConfig: QueriesConfig): Promise<void> {
  if (queriesConfig.init) {
    try {
      const scriptPath = resolvePath(Deno.cwd(), queriesConfig.init);
      const module = await importModule(scriptPath);
      if (module && typeof module.init === "function") {
        // Reset globalState before re-initializing
        globalState = {};
        // Execute the init function from the script
        await module.init({ pubsub, globalState });
        console.log(`Init script ${queriesConfig.init} executed successfully.`);
      } else {
        throw new Error(
          `The script ${queriesConfig.init} must export an 'init' function.`
        );
      }
    } catch (error) {
      console.error(`Error executing init script: ${error.message}`);
    }
  } else {
    // Reset globalState if no init script is provided
    globalState = {};
  }
}

/**
 * Builds resolvers for all object types in the schema.
 * @param queryEntries The array of query entries from queries.json.
 * @param schema The GraphQL schema.
 */
async function buildResolvers(
  queryEntries: QueryEntry[],
  resolveReferenceEntries: ResolveReferenceEntry[],
  schema: GraphQLSchema
): Promise<void> {
  console.log('Building resolvers with resolveReferenceEntries:', resolveReferenceEntries);
  resolvers = {}; // Reset resolvers

  const typeMap = schema.getTypeMap();

  for (const type of Object.values(typeMap)) {
    if (type.name.startsWith("__")) {
      continue; // Skip introspection types
    }

    if (!resolvers[type.name]) {
      resolvers[type.name] = {};
    }

    if (type instanceof GraphQLObjectType) {
      const fields = type.getFields();
      for (const fieldName of Object.keys(fields)) {
        const resolver = await createResolverFunction(
          type.name,
          fieldName,
          queryEntries,
          schema
        );
        if (resolver !== undefined) {
          resolvers[type.name][fieldName] = resolver;
        }
      }

      // Check if the type is an entity (has @key directive)
      const astNode = type.astNode;
      if (astNode && astNode.directives) {
        const keyDirective = astNode.directives.find(
          (d: any) => d.name.value === "key"
        );
        if (keyDirective) {
          // Implement __resolveReference using resolveReferenceEntries
          resolvers[type.name]["__resolveReference"] = await createReferenceResolver(
            type.name,
            resolveReferenceEntries,
            schema
          );
        }
      }
    }
  }
}


/**
 * Creates a resolver function for a given type and field.
 * @param typeName The name of the type ('Query', 'Mutation', 'Subscription', etc.).
 * @param fieldName The name of the field.
 * @param queryEntries The array of query entries from queries.json.
 * @param schema The GraphQL schema.
 * @returns A resolver function or an object with a subscribe function for subscriptions.
 */
async function createResolverFunction(
  typeName: string,
  fieldName: string,
  queryEntries: QueryEntry[],
  schema: GraphQLSchema
): Promise<any> {
  // For the special federation fields, do not override the default resolvers
  if (typeName === 'Query' && (fieldName === '_entities' || fieldName === '_service')) {
    // Do not assign a custom resolver for these fields
    return undefined;
  }

  let originalResolver: GraphQLFieldResolver<any, any>;
  switch (typeName) {
    case "Query":
      originalResolver = createQueryResolver(fieldName, queryEntries);
      break;
    case "Mutation":
      originalResolver = createMutationResolver(fieldName, queryEntries);
      break;
    case "Subscription":
      return createSubscriptionResolver(fieldName, queryEntries);
    default:
      originalResolver = createTypeResolver(typeName, fieldName, queryEntries);
      break;
  }

  // Get the expected return type from the schema
  const type = schema.getType(typeName);
  let fieldType: any;
  if (type instanceof GraphQLObjectType) {
    const fields = type.getFields();
    fieldType = fields[fieldName]?.type;
  }

  // Wrap the resolver to add __typename
  const wrappedResolver: GraphQLFieldResolver<any, any> = async (parent, args, context, info) => {
    const result = await originalResolver(parent, args, context, info);
    return addTypename(result, fieldType);
  };

  return wrappedResolver;
}

function createReferenceResolver(
  typeName: string,
  resolveReferenceEntries: ResolveReferenceEntry[],
  schema: GraphQLSchema
): GraphQLFieldResolver<any, any> {
  return async (reference: any) => {
    console.log(`Resolving reference for type: ${typeName}`);
    console.log('Available resolveReferenceEntries:', resolveReferenceEntries);
    const matchedEntry = resolveReferenceEntries.find(
      (entry) => entry.type === typeName
    );

    if (matchedEntry) {
      if (matchedEntry.tsScript) {
        const scriptPath = resolvePath(Deno.cwd(), matchedEntry.tsScript);
        const module = await importModule(scriptPath);
        if (module && typeof module.resolveReference === "function") {
          // Execute the resolveReference function from the script
          return await module.resolveReference(typeName, reference, {
            pubsub,
            globalState,
          });
        } else {
          throw new Error(
            `The script ${matchedEntry.tsScript} must export a 'resolveReference' function.`
          );
        }
      } else {
        throw new Error(`No tsScript provided for resolveReference of ${typeName}.`);
      }
    } else {
      throw new Error(`No resolveReference entry found for ${typeName}.`);
    }
  };
}


/**
 * Creates a resolver function for a Query field.
 * @param fieldName The name of the query field.
 * @param queryEntries The array of query entries from queries.json.
 * @returns A resolver function for the query.
 */
function createQueryResolver(
  fieldName: string,
  queryEntries: QueryEntry[]
): GraphQLFieldResolver<any, any> {
  return async (parent: any, args: any) => {
    const matchedQuery = findMatchedQuery("Query", fieldName, args, queryEntries);

    if (matchedQuery) {
      if (matchedQuery.tsScript) {
        const scriptPath = resolvePath(Deno.cwd(), matchedQuery.tsScript);
        const module = await importModule(scriptPath);
        if (module && typeof module.query === "function") {
          // Execute the query function from the script
          return await module.query("Query", fieldName, args, {
            pubsub,
            globalState,
          });
        } else {
          throw new Error(
            `The script ${matchedQuery.tsScript} must export a 'query' function.`
          );
        }
      } else {
        return matchedQuery.return;
      }
    } else if (parent && parent[fieldName] !== undefined) {
      // If parent has the field, return it
      return parent[fieldName];
    } else {
      // Return null or throw an error if no match is found
      throw new Error(`No matching query found for ${fieldName}.`);
    }
  };
}

/**
 * Creates a resolver function for a Mutation field.
 * @param fieldName The name of the mutation field.
 * @param queryEntries The array of query entries from queries.json.
 * @returns A resolver function for the mutation.
 */
function createMutationResolver(
  fieldName: string,
  queryEntries: QueryEntry[]
): GraphQLFieldResolver<any, any> {
  return async (parent: any, args: any) => {
    const matchedQuery = findMatchedQuery("Mutation", fieldName, args, queryEntries);

    if (matchedQuery) {
      let result;
      if (matchedQuery.tsScript) {
        const scriptPath = resolvePath(Deno.cwd(), matchedQuery.tsScript);
        const module = await importModule(scriptPath);
        if (module && typeof module.mutate === "function") {
          // Execute the mutate function from the script
          result = await module.mutate("Mutation", fieldName, args, {
            pubsub,
            globalState,
          });
        } else {
          throw new Error(
            `The script ${matchedQuery.tsScript} must export a 'mutate' function.`
          );
        }
      } else {
        // Simulate mutation effect
        result = matchedQuery.return;
      }

      // Check for publish actions
      if (matchedQuery.publish && Array.isArray(matchedQuery.publish)) {
        matchedQuery.publish.forEach((publishAction: PublishAction) => {
          const subscriptionName = publishAction.subscription;
          let payload = { ...publishAction.payload };
          // Replace "return" with the actual result
          Object.keys(payload).forEach((key) => {
            if (payload[key] === "return") {
              payload[key] = result;
            }
          });
          pubsub.publish(subscriptionName, payload);
        });
      }
      return result;
    } else {
      // Return null or throw an error if no match is found
      throw new Error(`No matching mutation found for ${fieldName}.`);
    }
  };
}

/**
 * Creates a resolver function for a Subscription field.
 * @param fieldName The name of the subscription field.
 * @param queryEntries The array of query entries from queries.json.
 * @returns An object with a subscribe function for the subscription.
 */
function createSubscriptionResolver(
  fieldName: string,
  queryEntries: QueryEntry[]
): { subscribe: Function } {
  return {
    subscribe: async (parent: any, args: any) => {
      const matchedSubscription = findMatchedQuery(
        "Subscription",
        fieldName,
        args,
        queryEntries
      );

      const asyncIterator = pubsub.asyncIterator(fieldName);

      if (matchedSubscription) {
        if (matchedSubscription.tsScript) {
          const scriptPath = resolvePath(Deno.cwd(), matchedSubscription.tsScript);
          const module = await importModule(scriptPath);
          if (module && typeof module.subscribe === "function") {
            // Execute the subscribe function from the script
            return await module.subscribe("Subscription", fieldName, args, {
              pubsub,
              globalState,
            });
          } else {
            throw new Error(
              `The script ${matchedSubscription.tsScript} must export a 'subscribe' function.`
            );
          }
        } else if (matchedSubscription.schedule) {
          const interval = matchedSubscription.schedule.interval;
          const payload = matchedSubscription.return;

          // Emit the payload every interval milliseconds
          const intervalId = setInterval(() => {
            pubsub.publish(fieldName, { [fieldName]: payload });
          }, interval);

          // Return an AsyncIterator that clears the interval when the subscription is canceled
          const asyncIterable = {
            [Symbol.asyncIterator]() {
              const iterator = asyncIterator[Symbol.asyncIterator]();
              return {
                async next() {
                  return iterator.next();
                },
                async return() {
                  clearInterval(intervalId);
                  return iterator.return ? iterator.return() : { done: true };
                },
                async throw(error: any) {
                  if (iterator.throw) {
                    return iterator.throw(error);
                  }
                  throw error;
                },
              };
            },
          };
          return asyncIterable;
        } else {
          // Default behavior
          return asyncIterator;
        }
      } else {
        // No matching subscription found
        throw new Error(`No matching subscription found for ${fieldName}.`);
      }
    },
  };
}

/**
 * Creates a resolver function for other types (e.g., User, Post).
 * @param typeName The name of the type.
 * @param fieldName The name of the field.
 * @param queryEntries The array of query entries from queries.json.
 * @returns A resolver function for the field.
 */
function createTypeResolver(
  typeName: string,
  fieldName: string,
  queryEntries: QueryEntry[]
): GraphQLFieldResolver<any, any> {
  return async (parent: any, args: any) => {
    // Try to find a matching entry in queries.json
    const matchedQuery = findMatchedQuery(typeName, fieldName, args, queryEntries);

    if (matchedQuery) {
      if (matchedQuery.tsScript) {
        const scriptPath = resolvePath(Deno.cwd(), matchedQuery.tsScript);
        const module = await importModule(scriptPath);
        if (module && typeof module.query === "function") {
          // Execute the query function from the script
          return await module.query(typeName, fieldName, args, {
            pubsub,
            globalState,
            parent,
          });
        } else {
          throw new Error(
            `The script ${matchedQuery.tsScript} must export a 'query' function.`
          );
        }
      } else {
        return matchedQuery.return;
      }
    } else if (parent && parent[fieldName] !== undefined) {
      // If parent has the field, return it
      return parent[fieldName];
    } else {
      // Return null or throw an error if no match is found
      throw new Error(`No matching resolver found for ${typeName}.${fieldName}.`);
    }
  };
}

/**
 * Finds a matching query entry from the query entries.
 * @param type The type of the operation ('Query', 'Mutation', 'Subscription', or other types).
 * @param field The field name.
 * @param args The arguments passed to the resolver.
 * @param queryEntries The array of query entries from queries.json.
 * @returns The matched query entry or undefined if not found.
 */
function findMatchedQuery(
  type: string,
  field: string,
  args: any,
  queryEntries: QueryEntry[]
): QueryEntry | undefined {
  return queryEntries.find((q) => {
    const typeMatches = q.type === type;
    const fieldMatches = q.field === field;

    // Treat undefined or empty parameters as wildcard
    const parametersAreWildcard =
      q.parameters === undefined || Object.keys(q.parameters).length === 0;

    const parametersMatch =
      parametersAreWildcard || deepEqual(q.parameters, args);

    return typeMatches && fieldMatches && parametersMatch;
  });
}

/**
 * Performs deep comparison of two objects.
 * @param a The first object.
 * @param b The second object.
 * @returns True if objects are equal, false otherwise.
 */
function deepEqual(a: any, b: any): boolean {
  return equal(a, b);
}

/**
 * Imports a module with cache busting to ensure the latest version is loaded.
 * @param scriptPath The path to the script file.
 * @returns The imported module.
 */
async function importModule(scriptPath: string): Promise<any> {
  const fullPath = resolvePath(scriptPath);
  const fileInfo = await Deno.stat(fullPath);
  const modifiedTime = fileInfo.mtime?.getTime() || Date.now();
  const scriptUrl = `file://${fullPath}?version=${modifiedTime}`;
  return await import(scriptUrl);
}

/**
 * Rebuilds the GraphQL schema and restarts the subscription server.
 */
async function rebuildSchema(): Promise<void> {
  console.log("Reloading schema and resolvers...");

  // Load queries
  const { queriesConfig, queryEntries, resolveReferenceEntries } = await loadQueries();

  // Re-execute the init script
  await executeInitScript(queriesConfig);

  // Build the temporary schema using buildSubgraphSchema
  const tempSchema = buildSubgraphSchema({
    typeDefs: parsedTypeDefs,
  });

  // Rebuild resolvers
  await buildResolvers(queryEntries, resolveReferenceEntries, tempSchema);

  // Build the subgraph schema with resolvers
  schema = buildSubgraphSchema({
    typeDefs: parsedTypeDefs,
    resolvers,
  });

  // Close existing subscription server
  if (subscriptionServer) {
    subscriptionServer.close();
  }

  // Set up the subscriptions-transport-ws server
  subscriptionServer = SubscriptionServer.create(
    {
      schema,
      execute,
      subscribe,
      onConnect: () => console.log("Client connected for subscriptions"),
      onDisconnect: () => console.log("Client disconnected from subscriptions"),
    },
    {
      server: httpServer,
      path: "/graphql",
    }
  );

  // Update Apollo Server with new schema
  if (apolloServer) {
    await apolloServer.stop(); // Stop the existing server
  }
  apolloServer = new ApolloServer({
    schema,
    introspection: true,
    plugins: [
      ApolloServerPluginLandingPageGraphQLPlayground({
        subscriptionEndpoint: `ws://localhost:${PORT}/graphql`,
      }),
      ApolloServerPluginDrainHttpServer({ httpServer }),
    ],
  });

  await apolloServer.start();
  apolloServer.applyMiddleware({ app });
  console.log("Schema and resolvers reloaded.");
}

// Start the server
const app = express();

// Create an HTTP server
const httpServer = createServer(app);

const PORT = args.port;

// Initial build of schema and resolvers
await rebuildSchema();

// Start the server
httpServer.listen(PORT, () => {
  console.log(
    `Server ready at http://localhost:${PORT}${apolloServer?.graphqlPath}`
  );
  console.log(
    `Subscriptions ready at ws://localhost:${PORT}${apolloServer?.graphqlPath}`
  );
});

// Watch for changes in queries.json and tsScript files
async function watchFiles() {
  const watcher = Deno.watchFs(Deno.cwd());
  console.log("Watching for file changes...");

  let reloadTimeout: number | null = null;

  for await (const event of watcher) {
    if (
      event.kind === "modify" ||
      event.kind === "create" ||
      event.kind === "remove"
    ) {
      const paths = event.paths;

      // Check if the schema file, queries file, or any tsScript files have changed
      let shouldReload = false;
      for (const path of paths) {
        if (
          path.endsWith(args.schema) ||
          path.endsWith(args.queries) ||
          path.endsWith(".ts")
        ) {
          shouldReload = true;
          break;
        }
      }

      if (shouldReload) {
        if (reloadTimeout) {
          clearTimeout(reloadTimeout);
        }
        reloadTimeout = setTimeout(async () => {
          try {
            await rebuildSchema();
          } catch (error) {
            console.error("Error reloading schema:", error);
          }
          reloadTimeout = null;
        }, 500); // Debounce interval in milliseconds
      }
    }
  }
}

// Start watching files
watchFiles();
