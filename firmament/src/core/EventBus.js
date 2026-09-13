/**
 * The seam between layers.
 *
 * Layers do not call each other's methods across boundaries; they announce.
 * This is what makes the future Weather / Trace / Agent layers additive rather
 * than invasive — they subscribe, they do not rewire.
 */
export class EventBus {
  #listeners = new Map();

  on(type, fn) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.#listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[firmament] listener for "${type}" failed`, err);
      }
    }
  }

  clear() {
    this.#listeners.clear();
  }
}
