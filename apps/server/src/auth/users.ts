/**
 * Dashboard users (issue #34, D-104; table `dashboard_users`, migration 0019).
 *
 * A row is created by the first OIDC sign-in of an (issuer, subject) and updated by every later
 * one: email, name, role and `last_login_at`. A sign-in that the role mapping refuses sets the
 * row's `role` to NULL, which ends every open session of that user at its next request (sessions
 * read the role on every request). There is no other way to create a user.
 *
 * Every method rejects when the store cannot answer; `AdminAuth` then fails closed.
 */
import type { Pool } from "pg";
import type { Role } from "./oidc.js";

export interface DashboardUser {
  readonly id: number;
  readonly subject: string;
  readonly email: string | undefined;
  readonly name: string | undefined;
  /** `undefined`: refused at the last sign-in; such a user has no access. */
  readonly role: Role | undefined;
}

export interface SignInRecord {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | undefined;
  readonly name: string | undefined;
}

export interface UserStore {
  /** Creates or updates the user for a successful sign-in; returns it. */
  signIn(record: SignInRecord, role: Role): Promise<DashboardUser>;
  /** Marks an existing user as refused (no role); returns its id, if there was one. */
  refuse(record: SignInRecord): Promise<number | undefined>;
  get(id: number): Promise<DashboardUser | undefined>;
}

interface Row {
  id: string;
  subject: string;
  email: string | null;
  name: string | null;
  role: string | null;
}

function fromRow(row: Row): DashboardUser {
  return Object.freeze({
    id: Number(row.id),
    subject: row.subject,
    email: row.email ?? undefined,
    name: row.name ?? undefined,
    role: row.role === "admin" || row.role === "viewer" ? row.role : undefined,
  });
}

export class PostgresUserStore implements UserStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async signIn(record: SignInRecord, role: Role): Promise<DashboardUser> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO dashboard_users (issuer, subject, email, name, role, last_login_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (issuer, subject) DO UPDATE
         SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
             last_login_at = EXCLUDED.last_login_at
       RETURNING id, subject, email, name, role`,
      [
        record.issuer,
        record.subject,
        record.email ?? null,
        record.name ?? null,
        role,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("no user row returned");
    return fromRow(row);
  }

  async refuse(record: SignInRecord): Promise<number | undefined> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE dashboard_users SET role = NULL
        WHERE issuer = $1 AND subject = $2
        RETURNING id`,
      [record.issuer, record.subject],
    );
    return rows[0] === undefined ? undefined : Number(rows[0].id);
  }

  async get(id: number): Promise<DashboardUser | undefined> {
    const { rows } = await this.pool.query<Row>(
      "SELECT id, subject, email, name, role FROM dashboard_users WHERE id = $1",
      [id],
    );
    return rows[0] === undefined ? undefined : fromRow(rows[0]);
  }
}

/** In-process users: the receiver-only test app, which has no database. */
export class MemoryUserStore implements UserStore {
  private readonly users = new Map<
    string,
    DashboardUser & { issuer: string }
  >();
  private nextId = 1;

  async signIn(record: SignInRecord, role: Role): Promise<DashboardUser> {
    const key = `${record.issuer}\0${record.subject}`;
    const id = this.users.get(key)?.id ?? this.nextId++;
    const user = Object.freeze({
      id,
      issuer: record.issuer,
      subject: record.subject,
      email: record.email,
      name: record.name,
      role,
    });
    this.users.set(key, user);
    return user;
  }

  async refuse(record: SignInRecord): Promise<number | undefined> {
    const key = `${record.issuer}\0${record.subject}`;
    const user = this.users.get(key);
    if (user === undefined) return undefined;
    this.users.set(key, { ...user, role: undefined });
    return user.id;
  }

  async get(id: number): Promise<DashboardUser | undefined> {
    for (const user of this.users.values()) if (user.id === id) return user;
    return undefined;
  }
}
