import * as actual from 'node:fs/promises';
export * from 'node:fs/promises';

export const fileFaults: {
  method: 'write' | 'rename' | 'unlink' | 'sync';
  path: string;
  code: string;
  partial?: boolean;
}[] = [];

function take(method: string, target: unknown) {
  const index = fileFaults.findIndex(
    (fault) => fault.method === method && String(target).includes(fault.path),
  );
  return index < 0 ? undefined : fileFaults.splice(index, 1)[0];
}

export const writeFile: typeof actual.writeFile = async (target, data, options) => {
  const fault = take('write', target);
  if (fault?.partial) await actual.writeFile(target, String(data).slice(0, 8), options);
  if (fault) throw Object.assign(new Error(`Fixture storage ${fault.code}`), { code: fault.code });
  await actual.writeFile(target, data, options);
};

export const rename: typeof actual.rename = async (source, destination) => {
  const fault = take('rename', source);
  if (fault) throw Object.assign(new Error(`Fixture storage ${fault.code}`), { code: fault.code });
  await actual.rename(source, destination);
};

export const unlink: typeof actual.unlink = async (target) => {
  const fault = take('unlink', target);
  if (fault) throw Object.assign(new Error(`Fixture storage ${fault.code}`), { code: fault.code });
  await actual.unlink(target);
};

export const open: typeof actual.open = async (target, flags, mode) => {
  const handle = await actual.open(target, flags, mode);
  const write = handle.writeFile.bind(handle);
  const sync = handle.sync.bind(handle);
  handle.writeFile = async (data, options) => {
    const fault = take('write', target);
    if (fault?.partial) await write(String(data).slice(0, 8), options);
    if (fault)
      throw Object.assign(new Error(`Fixture storage ${fault.code}`), { code: fault.code });
    return write(data, options);
  };
  handle.sync = async () => {
    const fault = take('sync', target);
    if (fault)
      throw Object.assign(new Error(`Fixture storage ${fault.code}`), { code: fault.code });
    await sync();
  };
  return handle;
};
