import sodium from "libsodium-wrappers-sumo";

let readyPromise: Promise<typeof sodium> | undefined;

export function ready(): Promise<typeof sodium> {
  readyPromise ??= sodium.ready.then(() => sodium);
  return readyPromise;
}

export type Sodium = Awaited<ReturnType<typeof ready>>;
