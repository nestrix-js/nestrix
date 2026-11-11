// A deliberately "realistic" Nest 12 app: one of every kind of thing the instance decorator can see.
import "reflect-metadata";
import { EventEmitter } from "node:events";
import {
  type ArgumentsHost,
  type CallHandler,
  type CanActivate,
  Catch,
  Controller,
  createParamDecorator,
  type ExceptionFilter,
  type ExecutionContext,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestInterceptor,
  type NestMiddleware,
  Param,
  ParseIntPipe,
  type PipeTransform,
  Scope,
  SetMetadata,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
// Classes injected by constructor type must be value imports, or `design:paramtypes` records `Object`.
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  HttpAdapterHost,
  Reflector,
} from "@nestjs/core";
import {
  type ClientProxy,
  ClientsModule,
  Transport,
} from "@nestjs/microservices";
import {
  Cron,
  CronExpression,
  Interval,
  ScheduleModule,
} from "@nestjs/schedule";
import {
  InjectDataSource,
  InjectRepository,
  TypeOrmModule,
} from "@nestjs/typeorm";
import { sql } from "drizzle-orm";
import { drizzle, type SQLJsDatabase } from "drizzle-orm/sql-js";
import type { Observable } from "rxjs";
import initSqlJs from "sql.js";
import {
  Column,
  type DataSource,
  Entity,
  PrimaryGeneratedColumn,
  type Repository,
} from "typeorm";

/** Calls observed by fixtures, reset per test. */
export const CALLS: string[] = [];
/** Handler names seen by a guard that reads `context.getHandler().name` (as @nestjs/throttler does). */
export const HANDLER_NAMES: string[] = [];
/** The handler function and class a global guard sees, per request (Q3). */
export const PROBES: Array<{
  cls: string;
  handler: { name: string };
}> = [];

// ---------- enhancers ----------

@Injectable()
export class DenyGuard implements CanActivate {
  canActivate() {
    CALLS.push("guard:deny");
    return false;
  }
}

/** Reads custom metadata through Reflector. If the metadata is lost it allows: fails open. */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext) {
    const role = this.reflector.get<string | undefined>(
      "role",
      ctx.getHandler(),
    );
    HANDLER_NAMES.push(ctx.getHandler().name);
    if (role === undefined) return true;
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string> }>();
    return req.headers["x-role"] === role;
  }
}

@Injectable()
export class GlobalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    CALLS.push("guard:global");
    PROBES.push({ cls: ctx.getClass().name, handler: ctx.getHandler() });
    return true;
  }
}

/** A guard without @Injectable(): legal when it has no dependencies. */
export class UndecoratedGuard implements CanActivate {
  canActivate() {
    CALLS.push("guard:undecorated");
    return true;
  }
}

export class UserConstructedGuard implements CanActivate {
  canActivate() {
    CALLS.push("guard:user-constructed");
    return true;
  }
}

@Injectable()
export class RecordingInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    CALLS.push("interceptor:method");
    return next.handle();
  }
}

@Injectable()
export class GlobalInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    CALLS.push("interceptor:global");
    return next.handle();
  }
}

/** Records the metatype Nest passes, which comes from `design:paramtypes` on the prototype. */
@Injectable()
export class MetatypePipe implements PipeTransform {
  transform(
    value: unknown,
    metadata: { type: string; metatype?: { name?: string } },
  ) {
    CALLS.push(`pipe:${metadata.type}:${metadata.metatype?.name ?? "none"}`);
    return value;
  }
}

@Injectable()
export class GlobalPipe implements PipeTransform {
  transform(value: unknown) {
    return value;
  }
}

@Catch(HttpException)
export class TeapotFilter implements ExceptionFilter {
  constructor(private readonly host: HttpAdapterHost) {}
  catch(exception: HttpException, host: ArgumentsHost) {
    CALLS.push("filter:teapot");
    const res = host.switchToHttp().getResponse();
    this.host.httpAdapter.reply(res, { filtered: true }, exception.getStatus());
  }
}

export class NeverThrown extends Error {}

@Catch(NeverThrown)
export class GlobalFilter implements ExceptionFilter {
  catch() {
    CALLS.push("filter:global");
  }
}

// ---------- middleware ----------

@Injectable()
export class ClassMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    CALLS.push("mw:class");
    next();
  }
}

export function functionMiddleware(
  _req: unknown,
  _res: unknown,
  next: () => void,
) {
  CALLS.push("mw:function");
  next();
}

export function appUseMiddleware(
  _req: unknown,
  _res: unknown,
  next: () => void,
) {
  CALLS.push("mw:app.use");
  next();
}

// ---------- param decorator ----------

export const Tag = createParamDecorator(
  (data: string, _ctx: ExecutionContext) => `tag:${data}`,
);

// ---------- services ----------

@Entity()
export class UserEntity {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column()
  name!: string;
}

export const DRIZZLE = Symbol("DRIZZLE");

@Injectable({ scope: Scope.TRANSIENT })
export class TransientService {
  static created = 0;
  readonly n = ++TransientService.created;
  which() {
    return this.n;
  }
}

@Injectable({ scope: Scope.REQUEST })
export class RequestScopedService {
  static created = 0;
  readonly n = ++RequestScopedService.created;
  which() {
    return this.n;
  }
}

/** Not decorated: produced by factory providers. */
export class PlainHelper {
  help() {
    return "help";
  }
}

@Injectable()
export class FactoryMadeService {
  made() {
    return "made";
  }
}

@Injectable()
export class UsersService {
  constructor(
    private readonly transient: TransientService,
    private readonly config: ConfigService,
    @InjectRepository(UserEntity) private readonly repo: Repository<UserEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(DRIZZLE) private readonly db: SQLJsDatabase,
    @Inject("MATH_CLIENT") readonly client: ClientProxy,
  ) {}
  find(id: number) {
    return {
      id,
      transient: this.transient.which(),
      x: this.config.get<number>("x"),
    };
  }
  async findAsync(id: number) {
    await new Promise((r) => setTimeout(r, 1));
    return this.find(id);
  }
  async dbRoundTrip() {
    await this.repo.save(this.repo.create({ name: "a" }));
    const typeorm = await this.repo.count();
    const raw = await this.dataSource.query("select 1 as one");
    const drizzleRows = this.db.all<{ one: number }>(sql`select 1 as one`);
    return { typeorm, raw: raw[0].one, drizzle: drizzleRows[0]?.one };
  }
}

@Injectable()
export class OtherService {
  constructor(readonly transient: TransientService) {}
  which() {
    return this.transient.which();
  }
}

// ---------- awkward classes (Q4) ----------

@Injectable()
export class PrivateService {
  #count = 0;
  #bump() {
    this.#count++;
    return this.#count;
  }
  increment() {
    return this.#bump();
  }
  peek() {
    return this.#count;
  }
  static isBranded(o: unknown): boolean {
    return typeof o === "object" && o !== null && #count in o;
  }
}

@Injectable()
export class MapService extends Map<string, number> {
  remember(k: string, v: number) {
    this.set(k, v);
    return this.get(k);
  }
}

@Injectable()
export class EmitterService extends EventEmitter {
  fire(payload: string) {
    return this.emit("evt", payload);
  }
}

/** Holds callable objects in fields, like a Mongoose model or an Axios instance. */
@Injectable()
export class CallableHolderService {
  readonly double = Object.assign((x: number) => x * 2, {
    tag: "callable",
    get: (k: string) => `get:${k}`,
  });
  readonly handler = () => "arrow-field";
  useDouble(x: number) {
    return this.double(x) + this.double.get("k").length;
  }
}

/** Generator and accessor members: must not be wrapped. */
@Injectable()
export class GeneratorService {
  *numbers() {
    yield 1;
    yield 2;
  }
  async *agen() {
    yield "a";
  }
  get computed() {
    return "computed";
  }
}

/** Returns a non-native thenable that also has its own methods (like a query builder). */
export class QueryLike {
  constructor(private readonly v: number) {}
  where(n: number) {
    return new QueryLike(this.v + n);
  }
  // biome-ignore lint/suspicious/noThenProperty: deliberately a thenable
  then(resolve: (v: number) => unknown) {
    return Promise.resolve(this.v).then(resolve);
  }
}

@Injectable()
export class ThenableService {
  query() {
    return new QueryLike(1);
  }
  async rejectLater() {
    await Promise.resolve();
    throw new Error("rejected on purpose");
  }
  throwSync() {
    throw new Error("thrown on purpose");
  }
}

// ---------- schedule (Q5) ----------

@Injectable()
export class TickService {
  static intervalRuns = 0;
  static cronRuns = 0;
  @Interval("s6-tick", 20)
  tick() {
    TickService.intervalRuns++;
  }
  @Cron(CronExpression.EVERY_SECOND, { name: "s6-cron" })
  everySecond() {
    TickService.cronRuns++;
  }
}

// ---------- controllers ----------

@Controller("users")
@UseInterceptors(RecordingInterceptor)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly other: OtherService,
  ) {}

  @Get("guarded")
  @UseGuards(DenyGuard)
  guarded() {
    return { reached: true };
  }

  @Get("code")
  @HttpCode(202)
  code() {
    return { code: 202 };
  }

  @Get("header")
  @Header("x-s6", "yes")
  header() {
    return { header: true };
  }

  @Get("meta")
  @SetMetadata("role", "admin")
  @UseGuards(RoleGuard)
  meta() {
    return { meta: true };
  }

  @Get("tag")
  tag(@Tag("hello") tag: string) {
    return { tag };
  }

  @Get("teapot")
  @UseFilters(TeapotFilter)
  teapot() {
    throw new HttpException("teapot", 418);
  }

  @Get("db")
  db() {
    return this.users.dbRoundTrip();
  }

  @Get("transient")
  transient() {
    return { users: this.users.find(1).transient, other: this.other.which() };
  }

  @Get("undecorated-guard")
  @UseGuards(UndecoratedGuard)
  undecoratedGuard() {
    return { ok: true };
  }

  @Get(":id")
  findOne(
    @Param("id", ParseIntPipe) id: number,
    @Param("id", MetatypePipe) raw: string,
  ) {
    return { ...this.users.find(id), raw };
  }

  @Get(":id/async")
  findAsync(@Param("id", ParseIntPipe) id: number) {
    return this.users.findAsync(id);
  }
}

/** Implicitly request-scoped through its dependency. */
@Controller("rs")
export class RequestScopedController {
  constructor(private readonly scoped: RequestScopedService) {}

  @Get("which")
  which() {
    return { n: this.scoped.which() };
  }

  @Get("guarded")
  @UseGuards(DenyGuard)
  guarded() {
    return { reached: true };
  }

  @Get("meta")
  @SetMetadata("role", "admin")
  @UseGuards(RoleGuard)
  meta() {
    return { meta: true };
  }

  @Get("code")
  @HttpCode(202)
  @Header("x-s6", "yes")
  code() {
    return { code: 202 };
  }
}

@Controller({ path: "explicit-rs", scope: Scope.REQUEST })
export class ExplicitRequestScopedController {
  @Get("guarded")
  @UseGuards(DenyGuard)
  guarded() {
    return { reached: true };
  }
}

// ---------- modules ----------

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ x: 1 })] }),
    TypeOrmModule.forRoot({
      type: "sqljs",
      entities: [UserEntity],
      synchronize: true,
      logging: false,
    }),
    TypeOrmModule.forFeature([UserEntity]),
    ClientsModule.register([
      { name: "MATH_CLIENT", transport: Transport.TCP, options: { port: 1 } },
    ]),
  ],
  controllers: [
    UsersController,
    RequestScopedController,
    ExplicitRequestScopedController,
  ],
  providers: [
    UsersService,
    OtherService,
    TransientService,
    RequestScopedService,
    PrivateService,
    MapService,
    EmitterService,
    CallableHolderService,
    GeneratorService,
    ThenableService,
    DenyGuard,
    RoleGuard,
    { provide: APP_GUARD, useClass: GlobalGuard },
    { provide: APP_INTERCEPTOR, useClass: GlobalInterceptor },
    { provide: APP_PIPE, useClass: GlobalPipe },
    { provide: APP_FILTER, useClass: GlobalFilter },
    {
      provide: DRIZZLE,
      useFactory: async () => {
        const SQL = await initSqlJs();
        return drizzle(new SQL.Database());
      },
    },
    { provide: "FACTORY_PLAIN", useFactory: () => ({ ping: () => "pong" }) },
    { provide: "FACTORY_CLASS", useFactory: () => new PlainHelper() },
    {
      provide: "FACTORY_INJECTABLE",
      useFactory: () => new FactoryMadeService(),
    },
    { provide: "FACTORY_FN", useFactory: () => () => "fn" },
    { provide: "FACTORY_PRIMITIVE", useFactory: () => 42 },
    { provide: "VALUE_OBJ", useValue: { a: 1 } },
    { provide: "VALUE_INSTANCE", useValue: new PlainHelper() },
    { provide: "ALIAS_CLASS", useClass: PlainHelper },
    { provide: "EXISTING", useExisting: UsersService },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(ClassMiddleware, functionMiddleware)
      .forRoutes(UsersController);
  }
}

@Module({ imports: [ScheduleModule.forRoot()], providers: [TickService] })
export class ScheduleFixtureModule {}

/** Classes defined by "the application" (this file). Everything else that passes through is framework or library. */
export const APP_CLASSES: ReadonlySet<unknown> = new Set<unknown>([
  DenyGuard,
  RoleGuard,
  GlobalGuard,
  UndecoratedGuard,
  UserConstructedGuard,
  RecordingInterceptor,
  GlobalInterceptor,
  MetatypePipe,
  GlobalPipe,
  TeapotFilter,
  GlobalFilter,
  ClassMiddleware,
  UserEntity,
  TransientService,
  RequestScopedService,
  PlainHelper,
  FactoryMadeService,
  UsersService,
  OtherService,
  PrivateService,
  MapService,
  EmitterService,
  CallableHolderService,
  GeneratorService,
  ThenableService,
  TickService,
  UsersController,
  RequestScopedController,
  ExplicitRequestScopedController,
  AppModule,
  ScheduleFixtureModule,
]);
