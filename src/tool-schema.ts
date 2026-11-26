type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumValues(schema: JsonObject): unknown[] | undefined {
  if (typeof schema.type !== 'string') return;
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Object.hasOwn(schema, 'const')) return [schema.const];
  return;
}

function mergeProperty(left: JsonObject, right: JsonObject): JsonObject {
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  const leftValues = enumValues(left);
  const rightValues = enumValues(right);
  if (!leftValues || !rightValues || left.type !== right.type) return { anyOf: [left, right] };
  const values = [...leftValues];
  for (const value of rightValues) {
    if (!values.some((existing) => JSON.stringify(existing) === JSON.stringify(value)))
      values.push(value);
  }
  const merged: JsonObject = { ...left, enum: values };
  delete merged.const;
  return merged;
}

function rootUnionKey(schema: JsonObject): 'anyOf' | 'oneOf' | undefined {
  if (Array.isArray(schema.anyOf)) return 'anyOf';
  if (Array.isArray(schema.oneOf)) return 'oneOf';
  return;
}

function mergeBranchProperties(properties: JsonObject, branch: unknown): string[] {
  if (!isJsonObject(branch) || branch.type !== 'object' || !isJsonObject(branch.properties))
    throw new Error('Provider tool schema union branches must be objects with properties.');
  const branchProperties = branch.properties;
  for (const [name, property] of Object.entries(branchProperties)) {
    if (!isJsonObject(property))
      throw new Error(`Provider tool property "${name}" must be an object schema.`);
    const existing = properties[name] as JsonObject | undefined;
    properties[name] = existing === undefined ? property : mergeProperty(existing, property);
  }
  return Array.isArray(branch.required)
    ? branch.required.filter((name): name is string => typeof name === 'string')
    : [];
}

/**
 * Providers such as OpenAI reject a function schema whose root is a union even
 * when every branch is an object. Flatten the root union into one object while
 * keeping the runtime validator authoritative for action-specific constraints.
 */
export function providerObjectSchema(schema: JsonObject): JsonObject {
  const unionKey = rootUnionKey(schema);
  if (!unionKey) {
    if (schema.type !== 'object') throw new Error('Provider tool schema root must be an object.');
    return schema;
  }

  const branches = schema[unionKey];
  if (!Array.isArray(branches) || branches.length === 0)
    throw new Error('Provider tool schema union must have at least one branch.');

  const properties: JsonObject = {};
  let required: string[] | undefined;
  for (const branch of branches) {
    const names = mergeBranchProperties(properties, branch);
    required = required === undefined ? names : required.filter((name) => names.includes(name));
  }

  const result: JsonObject = { ...schema, type: 'object', properties, additionalProperties: false };
  delete result.anyOf;
  delete result.oneOf;
  delete result.$schema;
  if (required?.length) result.required = required;
  else delete result.required;
  return result;
}
