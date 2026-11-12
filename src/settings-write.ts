import type BookkeepingPlugin from "./main";

/** Keep failed persistence from leaving phantom entries in the open form. */
export async function saveSettingField<T, K extends keyof T>(plugin: BookkeepingPlugin, target: T, key: K, value: T[K]): Promise<void> {
  const previous = target[key];
  target[key] = value;
  try { await plugin.saveSettingsQuietly(); }
  catch (error) {
    if (target[key] === value) target[key] = previous;
    throw error;
  }
}
