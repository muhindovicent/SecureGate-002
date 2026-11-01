import "dotenv/config";
import { defineConfig } from "prisma/config";
import { PrismaPg } from "@prisma/adapter-pg";
// The packaged WASM schema engine avoids native binary downloads.
// The maintained PG adapter supports PostgreSQL catalog NAME fields. Its default
// executeScript splits semicolons, which corrupts PL/pgSQL trigger bodies.
// Send each migration atomically on a dedicated PostgreSQL connection instead.
async function migrationAdapter() {
  const factory = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const connect = factory.connect.bind(factory);
  factory.connect = async () => {
    const driver = await connect();
    driver.executeScript = async (script) => {
      const connection = await driver.underlyingDriver().connect();
      try {
        await connection.query("BEGIN");
        await connection.query(script);
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    };
    return driver;
  };
  return factory;
}
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  experimental: { adapter: true },
  engine: "js",
  adapter: migrationAdapter,
});
