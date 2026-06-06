/**
 * Claude for Safari — Content Script
 *
 * Injected into every page. Provides helper utilities that the background
 * script can call via scripting.executeScript. Currently minimal — all DOM
 * interactions are done inline by the background script.
 */

// Expose a flag so the background can detect injection
window.__claudeForSafari = true;
