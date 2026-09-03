/**
 * The slice of a pino logger this package needs.
 *
 * Structural rather than an import so services can pass their own logger —
 * Fastify's, the coordinator's, a test double — without this package taking a
 * dependency on any particular logging library.
 */
export interface Logger {
  info(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
}
