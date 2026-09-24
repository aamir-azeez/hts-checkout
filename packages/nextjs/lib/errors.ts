import { Interface } from "ethers";

type ErrorShape = {
  data?: unknown;
  revert?: { name?: string } | null;
  error?: { data?: unknown };
  info?: { error?: { data?: unknown } };
};

export function contractErrorName(
  error: unknown,
  abi: readonly string[],
): string | undefined {
  if (!error || typeof error !== "object") return;
  const value = error as ErrorShape;
  if (value.revert?.name) return value.revert.name;
  const decoder = new Interface(abi);
  for (let data of [value.data, value.error?.data, value.info?.error?.data]) {
    for (
      let depth = 0;
      depth < 3 && data && typeof data === "object";
      depth += 1
    ) {
      data = (data as { data?: unknown }).data;
    }
    if (
      typeof data !== "string" ||
      data.length > 4096 ||
      !/^0x[0-9a-f]{8,}$/i.test(data)
    )
      continue;
    try {
      const decoded = decoder.parseError(data);
      if (decoded) return decoded.name;
    } catch {
      /* An unrecognized payload must not hide the original bounded error. */
    }
  }
}
