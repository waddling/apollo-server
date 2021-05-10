import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastify from 'fastify';

import http from 'http';

import request from 'request';

import { gql, AuthenticationError, Config, ApolloServerPluginCacheControlDisabled } from 'apollo-server-core';
import { ApolloServer, ServerRegistration } from '../ApolloServer';

import {
  testApolloServer,
  createServerInfo,
  createApolloFetch,
} from 'apollo-server-integration-testsuite';

const typeDefs = gql`
  type Query {
    hello: String
  }
`;

const resolvers = {
  Query: {
    hello: () => 'hi',
  },
};

const port = 9999;

describe('apollo-server-fastify', () => {
  let server: ApolloServer;
  let httpServer: http.Server;
  let app: FastifyInstance;

  testApolloServer(
    async (config: any, options) => {
      server = new ApolloServer(config);
      if (!options?.suppressStartCall) {
        await server.start();
      }
      app = fastify();
      app.register(server.createHandler());
      await app.listen(port);
      return createServerInfo(server, app.server);
    },
    async () => {
      if (server) await server.stop();
      if (app) await new Promise<void>(resolve => app.close(() => resolve()));
      if (httpServer && httpServer.listening) await httpServer.close();
    },
  );
});

describe('apollo-server-fastify', () => {
  let server: ApolloServer;
  let app: FastifyInstance;
  let httpServer: http.Server;
  let replyDecorator: jest.Mock | undefined;
  let requestDecorator: jest.Mock | undefined;

  async function createServer(
    serverOptions: Config,
    options: Partial<ServerRegistration> = {},
    mockDecorators: boolean = false,
  ) {
    server = new ApolloServer({ stopOnTerminationSignals: false, ...serverOptions });
    await server.start();
    app = fastify();

    if (mockDecorators) {
      replyDecorator = jest.fn();
      requestDecorator = jest.fn();

      app.decorateReply('replyDecorator', replyDecorator);
      app.decorateRequest('requestDecorator', requestDecorator);
    }

    app.register(server.createHandler(options));
    await app.listen(port);

    return createServerInfo(server, app.server);
  }

  afterEach(async () => {
    if (server) await server.stop();
    if (app) await new Promise<void>(resolve => app.close(() => resolve()));
    if (httpServer) await httpServer.close();
  });

  describe('constructor', () => {
    it('accepts typeDefs and resolvers', () => {
      return createServer({ typeDefs, resolvers });
    });
  });

  describe('createGraphQLServerOptions', () => {
    it('provides FastifyRequest and FastifyReply to ContextFunction', async () => {
      interface ContextArgs {
        request: FastifyRequest & {
          requestDecorator: () => any;
        };
        reply: FastifyReply & { replyDecorator: () => any };
      }

      const context = ({ request, reply }: ContextArgs) => {
        request!.requestDecorator();
        reply!.replyDecorator();
        return {};
      };

      const { url: uri } = await createServer(
        { typeDefs, resolvers, context },
        {},
        true,
      );

      const apolloFetch = createApolloFetch({ uri });
      await apolloFetch({ query: '{hello}' });

      expect(requestDecorator!.mock.calls.length).toEqual(1);
      expect(replyDecorator!.mock.calls.length).toEqual(1);
    });
  });

  describe('applyMiddleware', () => {
    it('can be queried', async () => {
      const { url: uri } = await createServer({
        typeDefs,
        resolvers,
      });
      const apolloFetch = createApolloFetch({ uri });
      const result = await apolloFetch({ query: '{hello}' });

      expect(result.data).toEqual({ hello: 'hi' });
      expect(result.errors).toBeUndefined();
    });

    // XXX Unclear why this would be something somebody would want (vs enabling
    // introspection without graphql-playground, which seems reasonable, eg you
    // have your own graphql-playground setup with a custom link)
    it('can enable playground separately from introspection during production', async () => {
      const INTROSPECTION_QUERY = `
  {
    __schema {
      directives {
        name
      }
    }
  }
`;

      const { url: uri } = await createServer({
        typeDefs,
        resolvers,
        introspection: false,
      });

      const apolloFetch = createApolloFetch({ uri });
      const result = await apolloFetch({ query: INTROSPECTION_QUERY });

      expect(result.errors.length).toEqual(1);
      expect(result.errors[0].extensions.code).toEqual(
        'GRAPHQL_VALIDATION_FAILED',
      );

      return new Promise<http.Server | void>((resolve, reject) => {
        request(
          {
            url: uri,
            method: 'GET',
            headers: {
              accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            },
          },
          (error, response, body) => {
            if (error) {
              reject(error);
            } else {
              expect(body).toMatch('GraphQLPlayground');
              expect(response.statusCode).toEqual(200);
              resolve();
            }
          },
        );
      });
    });

    it('renders GraphQL playground by default when browser requests', async () => {
      const nodeEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;

      const { url } = await createServer({
        typeDefs,
        resolvers,
      });

      return new Promise<http.Server | void>((resolve, reject) => {
        request(
          {
            url,
            method: 'GET',
            headers: {
              accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            },
          },
          (error, response, body) => {
            process.env.NODE_ENV = nodeEnv;
            if (error) {
              reject(error);
            } else {
              expect(body).toMatch('GraphQLPlayground');
              expect(body).not.toMatch('settings');
              expect(response.statusCode).toEqual(200);
              resolve();
            }
          },
        );
      });
    });

    const playgroundPartialOptionsTest = async () => {
      const defaultQuery = 'query { foo { bar } }';
      const endpoint = '/fumanchupacabra';
      const { url } = await createServer(
        {
          typeDefs,
          resolvers,
          playground: {
            // https://github.com/apollographql/graphql-playground/blob/0e452d2005fcd26f10fbdcc4eed3b2e2af935e3a/packages/graphql-playground-html/src/render-playground-page.ts#L16-L24
            // must be made partial
            settings: {
              'editor.theme': 'light',
            } as any,
            tabs: [
              {
                query: defaultQuery,
              },
              {
                endpoint,
              } as any,
            ],
          },
        },
        {},
      );

      return new Promise<http.Server | void>((resolve, reject) => {
        request(
          {
            url,
            method: 'GET',
            headers: {
              accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
              Folo: 'bar',
            },
          },
          (error, response, body) => {
            if (error) {
              reject(error);
            } else {
              expect(body).toMatch('GraphQLPlayground');
              expect(body).toMatch(`\"editor.theme\":\"light\"`);
              expect(body).toMatch(defaultQuery);
              expect(body).toMatch(endpoint);
              expect(response.statusCode).toEqual(200);
              resolve();
            }
          },
        );
      });
    };

    it('accepts partial GraphQL Playground Options in production', async () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      await playgroundPartialOptionsTest();
      process.env.NODE_ENV = nodeEnv;
    });

    it(
      'accepts partial GraphQL Playground Options when an environment is ' +
        'not specified',
      async () => {
        const nodeEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
        await playgroundPartialOptionsTest();
        process.env.NODE_ENV = nodeEnv;
      },
    );

    it('accepts playground options as a boolean', async () => {
      const nodeEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;

      const { url } = await createServer(
        {
          typeDefs,
          resolvers,
          playground: false,
        },
        {},
      );

      return new Promise<http.Server | void>((resolve, reject) => {
        request(
          {
            url,
            method: 'GET',
            headers: {
              accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            },
          },
          (error, response, body) => {
            process.env.NODE_ENV = nodeEnv;
            if (error) {
              reject(error);
            } else {
              expect(body).not.toMatch('GraphQLPlayground');
              expect(response.statusCode).not.toEqual(200);
              resolve();
            }
          },
        );
      });
    });

    it('accepts cors configuration', async () => {
      const { url: uri } = await createServer(
        {
          typeDefs,
          resolvers,
        },
        {
          cors: { origin: 'apollographql.com' },
        },
      );

      const apolloFetch = createApolloFetch({ uri }).useAfter(
        (response, next) => {
          expect(
            response.response.headers.get('access-control-allow-origin'),
          ).toEqual('apollographql.com');
          next();
        },
      );
      await apolloFetch({ query: '{hello}' });
    });

    describe('healthchecks', () => {
      afterEach(async () => {
        await server.stop();
      });

      it('creates a healthcheck endpoint', async () => {
        const { port } = await createServer({
          typeDefs,
          resolvers,
        });

        return new Promise<void>((resolve, reject) => {
          request(
            {
              url: `http://localhost:${port}/.well-known/apollo/server-health`,
              method: 'GET',
            },
            (error, response, body) => {
              if (error) {
                reject(error);
              } else {
                expect(body).toEqual(JSON.stringify({ status: 'pass' }));
                expect(response.statusCode).toEqual(200);
                resolve();
              }
            },
          );
        });
      });

      it('provides a callback for the healthcheck', async () => {
        const { port } = await createServer(
          {
            typeDefs,
            resolvers,
          },
          {
            onHealthCheck: async () => {
              throw Error("can't connect to DB");
            },
          },
        );

        return new Promise<void>((resolve, reject) => {
          request(
            {
              url: `http://localhost:${port}/.well-known/apollo/server-health`,
              method: 'GET',
            },
            (error, response, body) => {
              if (error) {
                reject(error);
              } else {
                expect(body).toEqual(JSON.stringify({ status: 'fail' }));
                expect(response.statusCode).toEqual(503);
                resolve();
              }
            },
          );
        });
      });

      it('can disable the healthCheck', async () => {
        const { port } = await createServer(
          {
            typeDefs,
            resolvers,
          },
          {
            disableHealthCheck: true,
          },
        );

        return new Promise<void>((resolve, reject) => {
          request(
            {
              url: `http://localhost:${port}/.well-known/apollo/server-health`,
              method: 'GET',
            },
            (error, response) => {
              if (error) {
                reject(error);
              } else {
                expect(response.statusCode).toEqual(404);
                resolve();
              }
            },
          );
        });
      });
    });

    describe('errors', () => {
      it('returns thrown context error as a valid graphql result', async () => {
        const nodeEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
        const typeDefs = gql`
          type Query {
            hello: String
          }
        `;
        const resolvers = {
          Query: {
            hello: () => {
              throw Error('never get here');
            },
          },
        };
        const { url: uri } = await createServer({
          typeDefs,
          resolvers,
          context: () => {
            throw new AuthenticationError('valid result');
          },
        });

        const apolloFetch = createApolloFetch({ uri });

        const result = await apolloFetch({ query: '{hello}' });
        expect(result.errors.length).toEqual(1);
        expect(result.data).toBeUndefined();

        const e = result.errors[0];
        expect(e.message).toMatch('valid result');
        expect(e.extensions).toBeDefined();
        expect(e.extensions.code).toEqual('UNAUTHENTICATED');
        expect(e.extensions.exception.stacktrace).toBeDefined();

        process.env.NODE_ENV = nodeEnv;
      });

      it('propogates error codes in dev mode', async () => {
        const nodeEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV;

        const { url: uri } = await createServer({
          typeDefs: gql`
            type Query {
              error: String
            }
          `,
          resolvers: {
            Query: {
              error: () => {
                throw new AuthenticationError('we the best music');
              },
            },
          },
        });

        const apolloFetch = createApolloFetch({ uri });

        const result = await apolloFetch({ query: `{error}` });
        expect(result.data).toBeDefined();
        expect(result.data).toEqual({ error: null });

        expect(result.errors).toBeDefined();
        expect(result.errors.length).toEqual(1);
        expect(result.errors[0].extensions.code).toEqual('UNAUTHENTICATED');
        expect(result.errors[0].extensions.exception).toBeDefined();
        expect(result.errors[0].extensions.exception.stacktrace).toBeDefined();

        process.env.NODE_ENV = nodeEnv;
      });

      it('propogates error codes in production', async () => {
        const nodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        const { url: uri } = await createServer({
          typeDefs: gql`
            type Query {
              error: String
            }
          `,
          resolvers: {
            Query: {
              error: () => {
                throw new AuthenticationError('we the best music');
              },
            },
          },
        });

        const apolloFetch = createApolloFetch({ uri });

        const result = await apolloFetch({ query: `{error}` });
        expect(result.data).toBeDefined();
        expect(result.data).toEqual({ error: null });

        expect(result.errors).toBeDefined();
        expect(result.errors.length).toEqual(1);
        expect(result.errors[0].extensions.code).toEqual('UNAUTHENTICATED');
        expect(result.errors[0].extensions.exception).toBeUndefined();

        process.env.NODE_ENV = nodeEnv;
      });

      it('propogates error codes with null response in production', async () => {
        const nodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        const { url: uri } = await createServer({
          typeDefs: gql`
            type Query {
              error: String!
            }
          `,
          resolvers: {
            Query: {
              error: () => {
                throw new AuthenticationError('we the best music');
              },
            },
          },
        });

        const apolloFetch = createApolloFetch({ uri });

        const result = await apolloFetch({ query: `{error}` });
        expect(result.data).toBeNull();

        expect(result.errors).toBeDefined();
        expect(result.errors.length).toEqual(1);
        expect(result.errors[0].extensions.code).toEqual('UNAUTHENTICATED');
        expect(result.errors[0].extensions.exception).toBeUndefined();

        process.env.NODE_ENV = nodeEnv;
      });
    });
  });

  describe('extensions', () => {
    const books = [
      {
        title: 'H',
        author: 'J',
      },
    ];

    const typeDefs = gql`
      type Book {
        title: String
        author: String
      }

      type Cook @cacheControl(maxAge: 200) {
        title: String
        author: String
      }

      type Pook @cacheControl(maxAge: 200) {
        title: String
        books: [Book] @cacheControl(maxAge: 20, scope: PRIVATE)
      }

      type Query {
        books: [Book]
        cooks: [Cook]
        pooks: [Pook]
      }

      enum CacheControlScope {
        PUBLIC
        PRIVATE
      }

      directive @cacheControl(
        maxAge: Int
        scope: CacheControlScope
      ) on FIELD_DEFINITION | OBJECT | INTERFACE
    `;

    const resolvers = {
      Query: {
        books: () => books,
        cooks: () => books,
        pooks: () => [{ title: 'pook', books }],
      },
    };

    describe('Cache Control Headers', () => {
      it('applies cacheControl Headers', async () => {
        const { url: uri } = await createServer({ typeDefs, resolvers });

        const apolloFetch = createApolloFetch({ uri }).useAfter(
          (response, next) => {
            expect(response.response.headers.get('cache-control')).toEqual(
              'max-age=200, public',
            );
            next();
          },
        );
        const result = await apolloFetch({
          query: `{ cooks { title author } }`,
        });
        expect(result.data).toEqual({ cooks: books });
      });

      it('contains no cacheControl Headers when uncachable', async () => {
        const { url: uri } = await createServer({ typeDefs, resolvers });

        const apolloFetch = createApolloFetch({ uri }).useAfter(
          (response, next) => {
            expect(response.response.headers.get('cache-control')).toBeNull();
            next();
          },
        );
        const result = await apolloFetch({
          query: `{ books { title author } }`,
        });
        expect(result.data).toEqual({ books });
      });

      it('contains private cacheControl Headers when scoped', async () => {
        const { url: uri } = await createServer({ typeDefs, resolvers });

        const apolloFetch = createApolloFetch({ uri }).useAfter(
          (response, next) => {
            expect(response.response.headers.get('cache-control')).toEqual(
              'max-age=20, private',
            );
            next();
          },
        );
        const result = await apolloFetch({
          query: `{ pooks { title books { title author } } }`,
        });
        expect(result.data).toEqual({
          pooks: [{ title: 'pook', books }],
        });
      });

      it('runs when cache-control is false', async () => {
        const { url: uri } = await createServer({
          typeDefs,
          resolvers,
          plugins: [ApolloServerPluginCacheControlDisabled()],
        });

        const apolloFetch = createApolloFetch({ uri }).useAfter(
          (response, next) => {
            expect(response.response.headers.get('cache-control')).toBeNull();
            next();
          },
        );
        const result = await apolloFetch({
          query: `{ pooks { title books { title author } } }`,
        });
        expect(result.data).toEqual({
          pooks: [{ title: 'pook', books }],
        });
      });
    });
  });
});
