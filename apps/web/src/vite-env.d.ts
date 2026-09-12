/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Toggle the partytracks realtime client implementation. "true" enables
   * partytracks; unset/"false" keeps the hand-rolled SFU client. See
   * `config/featureFlags.ts`.
   */
  readonly VITE_USE_PARTYTRACKS?: string;
}
