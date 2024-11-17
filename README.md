# GraphQL Mock

GraphQL Mock is a flexible and powerful tool for creating mock GraphQL servers. It allows you to define your schema, queries, and custom resolvers with ease, making it ideal for testing, prototyping, or developing front-end applications without relying on a real backend.

## Features

- **Schema-Driven:** Define your GraphQL schema using `.graphqls` files.
- **Configurable Queries:** Easily specify queries, mutations, and subscriptions via a `queries.json` configuration file.
- **Custom Resolvers:** Extend functionality with custom TypeScript scripts for complex resolver logic.
- **Real-Time Subscriptions:** Support for GraphQL subscriptions using `graphql-subscriptions` and `subscriptions-transport-ws`.
- **Hot Reloading:** Automatically reloads schema and resolvers on file changes for a seamless development experience.
- **Integrated Playground:** Access the GraphQL Playground for interactive querying and testing.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
  - [Schema](#schema)
  - [Queries](#queries)
  - [Custom Resolvers](#custom-resolvers)
- [Running the Server](#running-the-server)
- [Example](#example)
- [Contributing](#contributing)
- [License](#license)

## Installation

Ensure you have [Deno](https://deno.land/) installed on your machine.

1. **Clone the Repository**

   ```bash
   git clone https://github.com/yourusername/graphql_mock.git
   cd graphql_mock
   ```

2. **Install Dependencies**

   GraphQL Mock uses both Deno and npm packages. Ensure you have Node.js installed to handle npm dependencies.

   ```bash
   npm install
   ```

## Usage

GraphQL Mock reads your schema and query configurations to start a mock GraphQL server.

### Command-Line Options

- `--schema` or `-s`: Path to your GraphQL schema file. Default is `schema.graphqls`.
- `--queries` or `-q`: Path to your queries configuration file. Default is `queries.json`.
- `--port` or `-p`: Port number for the server to listen on. Default is `4000`.

### Running the Server

```bash
deno run --allow-net --allow-read index.ts --schema=path/to/schema.graphqls --queries=path/to/queries.json --port=4000
```

**Example:**

```bash
deno run --allow-net --allow-read index.ts
```

This command starts the server with default configurations:
- Schema: `schema.graphqls`
- Queries: `queries.json`
- Port: `4000`

## Configuration

### Schema

Define your GraphQL schema in a `.graphqls` file. This schema outlines the types, queries, mutations, and subscriptions your mock server will support.

**Example `schema.graphqls`:**

```graphql
type Query {
  hello: String
}

type Mutation {
  setMessage(message: String!): String
}

type Subscription {
  messageAdded: String
}
```

### Queries

Configure your queries, mutations, and subscriptions in a `queries.json` file. This file maps GraphQL operations to their mock implementations or static responses.

**Example `queries.json`:**

```json
{
  "init": "scripts/init.ts",
  "queries": [
    {
      "type": "Query",
      "field": "hello",
      "return": "Hello, world!"
    },
    {
      "type": "Mutation",
      "field": "setMessage",
      "parameters": {
        "message": "Hello"
      },
      "tsScript": "scripts/setMessage.ts",
      "publish": [
        {
          "subscription": "messageAdded",
          "payload": {
            "messageAdded": "return"
          }
        }
      ]
    },
    {
      "type": "Subscription",
      "field": "messageAdded",
      "schedule": {
        "interval": 5000
      },
      "return": "New message received!"
    }
  ],
  "resolveReferences": [
    {
      "type": "User",
      "tsScript": "scripts/resolveUser.ts"
    }
  ]
}
```

### Custom Resolvers

For complex logic, you can define custom resolvers using TypeScript scripts. These scripts should export specific functions based on the operation type.

#### Init Script

The `init` script runs when the server starts or reloads. It's useful for initializing global state or setting up PubSub.

**Example `scripts/init.ts`:**

```typescript
export function init({ pubsub, globalState }) {
  globalState.message = "Initial message";
  pubsub.publish("messageAdded", { messageAdded: globalState.message });
}
```

#### Query Resolver

Custom resolver for queries.

**Example `scripts/setMessage.ts`:**

```typescript
export async function mutate(type, field, args, { pubsub, globalState }) {
  globalState.message = args.message;
  pubsub.publish("messageAdded", { messageAdded: globalState.message });
  return globalState.message;
}
```

#### Reference Resolver

Used for federated schemas to resolve references.

**Example `scripts/resolveUser.ts`:**

```typescript
export async function resolveReference(type, reference, { pubsub, globalState }) {
  return {
    id: reference.id,
    name: "John Doe"
  };
}
```

## Running the Server

Start the server with your configuration:

```bash
deno run --allow-net --allow-read index.ts --schema=schema.graphqls --queries=queries.json --port=4000
```

- **Access GraphQL Playground:**
  
  Open [http://localhost:4000/graphql](http://localhost:4000/graphql) in your browser to interact with the GraphQL Playground.

- **Subscriptions:**
  
  Subscriptions are available at the same endpoint using WebSockets.

## Example

Here's a simple example to get you started.

1. **Define Schema (`schema.graphqls`):**

   ```graphql
   type Query {
     hello: String
   }

   type Mutation {
     setMessage(message: String!): String
   }

   type Subscription {
     messageAdded: String
   }
   ```

2. **Configure Queries (`queries.json`):**

   ```json
   {
     "init": "scripts/init.ts",
     "queries": [
       {
         "type": "Query",
         "field": "hello",
         "return": "Hello, world!"
       },
       {
         "type": "Mutation",
         "field": "setMessage",
         "tsScript": "scripts/setMessage.ts",
         "publish": [
           {
             "subscription": "messageAdded",
             "payload": {
               "messageAdded": "return"
             }
           }
         ]
       },
       {
         "type": "Subscription",
         "field": "messageAdded",
         "schedule": {
           "interval": 5000
         },
         "return": "New message received!"
       }
     ]
   }
   ```

3. **Create Init Script (`scripts/init.ts`):**

   ```typescript
   export function init({ pubsub, globalState }) {
     globalState.message = "Initial message";
     pubsub.publish("messageAdded", { messageAdded: globalState.message });
   }
   ```

4. **Create Mutation Resolver (`scripts/setMessage.ts`):**

   ```typescript
   export async function mutate(type, field, args, { pubsub, globalState }) {
     globalState.message = args.message;
     pubsub.publish("messageAdded", { messageAdded: globalState.message });
     return globalState.message;
   }
   ```

5. **Start the Server:**

   ```bash
   deno run --allow-net --allow-read index.ts
   ```

6. **Interact via GraphQL Playground:**

   - **Query:**

     ```graphql
     query {
       hello
     }
     ```

   - **Mutation:**

     ```graphql
     mutation {
       setMessage(message: "Hello, GraphQL Mock!")
     }
     ```

   - **Subscription:**

     ```graphql
     subscription {
       messageAdded
     }
     ```

## Contributing

Contributions are welcome! Please follow these steps:

1. **Fork the Repository**

2. **Create a Feature Branch**

   ```bash
   git checkout -b feature/YourFeature
   ```

3. **Commit Your Changes**

   ```bash
   git commit -m "Add YourFeature"
   ```

4. **Push to the Branch**

   ```bash
   git push origin feature/YourFeature
   ```

5. **Open a Pull Request**

Please ensure your code follows the project's coding standards and includes relevant tests.

## License

This project is licensed under the [MIT License](LICENSE).

---
