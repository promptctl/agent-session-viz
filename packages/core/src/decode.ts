// Decoders: the one way raw JSON becomes a typed value in core. Each decoder either
// returns its type or says, with a path, why the input is not that type.

// [LAW:parse-dont-validate] JSON.parse output is stamped as Json once, so nothing
// downstream ever handles `unknown`.
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
export type JsonObject = { readonly [key: string]: Json };

export type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

// A missing object key reaches its field decoder as undefined, so optionality is one
// more decoder rather than a special case inside object().
export type Decoder<T> = (input: Json | undefined, path: string) => Decoded<T>;

export type Infer<D> = D extends Decoder<infer T> ? T : never;

type Shape = { readonly [key: string]: Decoder<unknown> };
type ObjectOf<S extends Shape> = { readonly [K in keyof S]: Infer<S[K]> };

const ok = <T>(value: T): Decoded<T> => ({ ok: true, value });

function fail(path: string, expected: string, input: Json | undefined): Decoded<never> {
  return { ok: false, reason: `${path || "(root)"}: expected ${expected}, got ${describe(input)}` };
}

function describe(input: Json | undefined): string {
  if (input === undefined) return "nothing";
  if (input === null) return "null";
  return isJsonArray(input) ? "array" : typeof input;
}

const isJsonArray = (input: Json | undefined): input is readonly Json[] => Array.isArray(input);

const isJsonObject = (input: Json | undefined): input is JsonObject =>
  typeof input === "object" && input !== null && !isJsonArray(input);

const child = (path: string, key: string): string => (path ? `${path}.${key}` : key);

export function parseJson(text: string): Decoded<Json> {
  try {
    const value: Json = JSON.parse(text);
    return ok(value);
  } catch (error) {
    // JSON.parse without a reviver throws only SyntaxError, whose message is the reason.
    return { ok: false, reason: String(error) };
  }
}

export const string: Decoder<string> = (input, path) =>
  typeof input === "string" ? ok(input) : fail(path, "string", input);

export const number: Decoder<number> = (input, path) =>
  typeof input === "number" ? ok(input) : fail(path, "number", input);

export const boolean: Decoder<boolean> = (input, path) =>
  typeof input === "boolean" ? ok(input) : fail(path, "boolean", input);

// Any present value, kept as JSON until something needs to read inside it.
export const json: Decoder<Json> = (input, path) =>
  input === undefined ? fail(path, "a value", input) : ok(input);

export const nullable =
  <T>(decode: Decoder<T>): Decoder<T | null> =>
  (input, path) =>
    input === null ? ok(null) : decode(input, path);

export const optional =
  <T>(decode: Decoder<T>): Decoder<T | undefined> =>
  (input, path) =>
    input === undefined ? ok(undefined) : decode(input, path);

// For fields the format omits when they hold their default, such as a false flag.
// The default is resolved here, once, so no consumer re-derives it.
export const absentAs =
  <T>(decode: Decoder<T>, fallback: T): Decoder<T> =>
  (input, path) =>
    input === undefined ? ok(fallback) : decode(input, path);

export const either =
  <A, B>(first: Decoder<A>, second: Decoder<B>): Decoder<A | B> =>
  (input, path) => {
    const a = first(input, path);
    if (a.ok) return a;
    const b = second(input, path);
    return b.ok ? b : { ok: false, reason: `${a.reason}; or ${b.reason}` };
  };

export const array =
  <T>(item: Decoder<T>): Decoder<readonly T[]> =>
  (input, path) => {
    if (!isJsonArray(input)) return fail(path, "array", input);
    const value: T[] = [];
    for (const [index, element] of input.entries()) {
      const decoded = item(element, `${path}[${index}]`);
      if (!decoded.ok) return decoded;
      value.push(decoded.value);
    }
    return ok(value);
  };

// Reads the keys the shape names and ignores the rest.
export type ObjectDecoder<S extends Shape> = Decoder<ObjectOf<S>> & { readonly shape: S };

// The decoder carries its shape so a larger object can spread these fields into its own.
export function object<S extends Shape>(shape: S): ObjectDecoder<S> {
  const fields = Object.entries(shape);
  const decode: Decoder<ObjectOf<S>> = (input, path) => {
    if (!isJsonObject(input)) return fail(path, "object", input);
    const value: { [key: string]: unknown } = {};
    for (const [key, decode] of fields) {
      // Own keys only, so a field named like an Object.prototype member is absent, not a function.
      const decoded = decode(Object.hasOwn(input, key) ? input[key] : undefined, child(path, key));
      if (!decoded.ok) return decoded;
      value[key] = decoded.value;
    }
    // [LAW:types-are-the-program] exception: the loop above assigned every key of the
    // shape its decoded value; TypeScript cannot follow a loop over a mapped type.
    return ok(value as ObjectOf<S>);
  };
  return Object.assign(decode, { shape });
}

export type Variant<Tag extends string, T> = { readonly tag: Tag; readonly decode: Decoder<T> };

export function variant<Tag extends string, S extends Shape>(
  tag: Tag,
  shape: S,
): Variant<Tag, { readonly type: Tag } & ObjectOf<S>> {
  const decodeFields = object(shape);
  return {
    tag,
    decode: (input, path) => {
      const decoded = decodeFields(input, path);
      return decoded.ok ? ok({ ...decoded.value, type: tag }) : decoded;
    },
  };
}

// The two arms every tagged union gets. `unknown` is a type this decoder does not
// recognize; `malformed` is a type it recognizes whose fields do not fit. Both keep the
// whole object, so nothing is dropped and the enclosing value still decodes.
export type UnknownArm = { readonly type: "unknown"; readonly raw: JsonObject };
export type MalformedArm = { readonly type: "malformed"; readonly raw: JsonObject; readonly reason: string };

type VariantValue<V> = V extends Variant<string, infer T> ? T : never;

// [LAW:single-enforcer] the one place a `type`-tagged JSON object is sorted into
// recognized, unrecognized, or broken; records, content blocks, and attachments all
// route through it. A value that is not an object with a string `type` is not a tagged
// value at all, so that fails the enclosing decoder instead.
export function tagged<const Vs extends readonly Variant<string, object>[]>(
  ...variants: Vs
): Decoder<VariantValue<Vs[number]> | UnknownArm | MalformedArm> {
  // [LAW:types-are-the-program] exception: each variant's decoder produces its own arm of the
  // union; TypeScript widens them to Decoder<object> when they share one array.
  const byTag = new Map<string, Decoder<VariantValue<Vs[number]>>>(
    variants.map((v): [string, Decoder<VariantValue<Vs[number]>>] => [v.tag, v.decode as Decoder<VariantValue<Vs[number]>>]),
  );
  return (input, path) => {
    if (!isJsonObject(input)) return fail(path, "object", input);
    const type = input["type"];
    if (typeof type !== "string") return fail(child(path, "type"), "string", type);
    const decode = byTag.get(type);
    if (decode === undefined) return ok({ type: "unknown", raw: input });
    const decoded = decode(input, path);
    return decoded.ok ? decoded : ok({ type: "malformed", raw: input, reason: `${type}: ${decoded.reason}` });
  };
}
