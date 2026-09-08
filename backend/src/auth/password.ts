import argon2 from "argon2";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

let dummyHashPromise: Promise<string> | undefined;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function verifyAgainstDummyHash(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword("timing-safe-dummy-password");
  const dummyHash = await dummyHashPromise;
  await verifyPassword(dummyHash, password);
}
