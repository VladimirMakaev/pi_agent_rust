/**
 * Read/write extension settings to JSON files.
 */
/**
 * Get a setting value for an extension.
 * Returns the stored value, or the provided default, or undefined.
 *
 * @param extensionName - Extension name
 * @param settingId - Setting ID within the extension
 * @param defaultValue - Default value if setting is not found
 * @returns The setting value
 */
export declare function getSetting(extensionName: string, settingId: string, defaultValue?: string): string | undefined;
/**
 * Set a setting value for an extension.
 * Always writes to the global settings file.
 *
 * @param extensionName - Extension name
 * @param settingId - Setting ID within the extension
 * @param value - Value to set
 */
export declare function setSetting(extensionName: string, settingId: string, value: string): void;
//# sourceMappingURL=storage.d.ts.map