/**
 * Utility for safe Tauri API usage in both desktop and web environments
 */

/**
 * Check if Tauri APIs are available (app is running in desktop mode)
 * Does NOT cache - checks every time for reliability during dev mode
 */
export const isTauriAvailable = (): boolean => {
  try {
    if (typeof window === "undefined") return false;

    // Tauri v2 injects __TAURI_INTERNALS__ or __TAURI_IPC__
    // Tauri v1 used __TAURI__
    const w = window as any;
    return (
      typeof w.__TAURI_INTERNALS__ !== "undefined" || 
      typeof w.__TAURI_IPC__ !== "undefined" || 
      typeof w.__TAURI__ !== "undefined"
    );
  } catch {
    return false;
  }
};

/**
 * Safely invoke Tauri commands with fallback for web mode
 */
export const safeInvoke = async <T,>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> => {
  if (!isTauriAvailable()) {
    console.warn(`Tauri command "${command}" called in web mode - ignoring`);
    return null;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, args);
  } catch (error) {
    console.error(`Error invoking Tauri command "${command}":`, error);
    throw error;
  }
};

/**
 * Check if dialog APIs are available
 */
export const safeDialogOpen = async (options?: Parameters<typeof import("@tauri-apps/plugin-dialog").open>[0]) => {
  if (!isTauriAvailable()) {
    console.warn("Dialog.open called in web mode - returning null");
    return null;
  }

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    return await open(options);
  } catch (error) {
    console.error("Error opening dialog:", error);
    throw error;
  }
};

/**
 * Check if dialog save is available
 */
export const safeDialogSave = async (options?: Parameters<typeof import("@tauri-apps/plugin-dialog").save>[0]) => {
  if (!isTauriAvailable()) {
    console.warn("Dialog.save called in web mode - returning null");
    return null;
  }

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return await save(options);
  } catch (error) {
    console.error("Error saving dialog:", error);
    throw error;
  }
};

/**
 * Check if listen is available
 */
export const safeEventListen = async <T,>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<(() => void) | null> => {
  if (!isTauriAvailable()) {
    console.warn(`Event listener for "${event}" registered in web mode - will not receive events`);
    return null;
  }

  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<T>(event, handler);
  } catch (error) {
    console.error(`Error listening to event "${event}":`, error);
    throw error;
  }
};
