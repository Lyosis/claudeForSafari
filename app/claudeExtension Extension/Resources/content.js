/**
 * Claude for Safari — Content Script
 *
 * Injected into every page at document_idle.
 * Currently minimal — all DOM interactions are performed inline by the
 * background script via tabs.executeScript.
 *
 * This file intentionally left sparse. It exists so Safari loads the
 * content script context on every page, which can reduce first-injection
 * latency for future helper utilities.
 */
