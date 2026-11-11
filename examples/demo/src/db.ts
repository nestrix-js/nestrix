import pg from "pg";

/** One pool for the app; `DATABASE_URL` defaults to the container `pnpm demo:db` starts. */
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/postgres",
  max: 5,
});

export async function seed(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (id int PRIMARY KEY, name text NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id int PRIMARY KEY, customer_id int NOT NULL, total numeric NOT NULL, status text NOT NULL);
    INSERT INTO customers VALUES (1,'Ada'),(2,'Grace'),(3,'Linus'),(4,'Margaret'),(5,'Ken') ON CONFLICT DO NOTHING;
    INSERT INTO orders SELECT g, 1 + g % 5, round((random()*200)::numeric, 2), CASE WHEN g % 7 = 0 THEN 'refunded' ELSE 'paid' END
      FROM generate_series(1, 40) g ON CONFLICT DO NOTHING;
  `);
}
