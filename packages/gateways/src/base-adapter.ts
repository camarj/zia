/**
 * base-adapter.ts — BaseAdapter abstract class (spec §2.2, design §1, ADR-5).
 *
 * SPEC-R2: This file MUST NOT import @zia/core or the pi.dev SDK.
 * Transport lives entirely in concrete subclasses.
 *
 * Lifecycle is FINAL — subclasses implement _start()/_stop() only.
 * connect()/disconnect() guard against double-start/double-stop.
 *
 * emit() is protected — only the subclass calls it to push inbound
 * MessageEvents into the runner. The callback is wired by GatewayRunner
 * via _attach() (called from register()). Throws if called before attach.
 */
import type { ApprovalView, MessageEvent } from "./types.ts";

export abstract class BaseAdapter {
  /** Platform identifier — must match MessageEvent.platform emitted by this adapter. */
  abstract readonly platform: string;

  // Internal state — not exposed to subclasses or callers.
  #connected = false;
  #emitFn: ((event: MessageEvent) => void) | null = null;

  /**
   * Wire this adapter's emit() callback to the runner's handleMessage.
   * Called exclusively by GatewayRunner.register(). Not part of the public
   * adapter contract — hence the _attach name (internal convention).
   *
   * @internal
   */
  _attach(emit: (event: MessageEvent) => void): void {
    this.#emitFn = emit;
  }

  /**
   * Final lifecycle — calls _start() exactly once.
   * Idempotent: calling connect() on an already-connected adapter is a no-op.
   */
  async connect(): Promise<void> {
    if (this.#connected) return;
    this.#connected = true;
    await this._start();
  }

  /**
   * Final lifecycle — calls _stop() exactly once.
   * Idempotent: calling disconnect() on an already-disconnected adapter is a no-op.
   * Safe to call even if connect() was never called.
   */
  async disconnect(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    await this._stop();
  }

  /**
   * Push an inbound MessageEvent into the runner.
   * Subclasses call this when a message arrives from their transport.
   * Throws if _attach() has not been called yet (adapter not registered).
   */
  protected emit(event: MessageEvent): void {
    if (!this.#emitFn) {
      throw new Error(
        "zia/gateways: BaseAdapter.emit() called before the adapter was registered with a GatewayRunner. " +
          "Call runner.register(adapter) before adapter.connect().",
      );
    }
    this.#emitFn(event);
  }

  /** Called by connect() — subclasses start their transport here. */
  protected abstract _start(): Promise<void>;

  /** Called by disconnect() — subclasses tear down their transport here. */
  protected abstract _stop(): Promise<void>;

  /** Send a text response back to a specific chat on this platform. */
  abstract sendMessage(chatId: string, text: string): Promise<void>;

  /** Display an approval request to the human boss on this platform. */
  abstract sendApprovalRequest(view: ApprovalView): Promise<void>;
}
