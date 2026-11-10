// A disconnect from TeamHub can arrive while a connection is still opening:
// its token and the permission count it read predate the change, but it is not
// yet among the Document's connections. Each connection keeps the disconnect
// counts it opened under, so one that a later disconnect covers is refused or
// closed wherever it next acts.
//
// Counts exist only while some connection holds a mark on the Document. With
// no holder there is no connection a disconnect could still need to reach, so
// the Document's entry is dropped and a later mark starts from zero.
export interface DisconnectMark {
  document: number;
  actor: number;
  // release ends the connection's hold; calling it again does nothing.
  release(): void;
}

interface DocumentDisconnects {
  count: number;
  actors: Map<string, number>;
  holders: number;
}

export class ConnectionDisconnects {
  readonly #documents = new Map<string, DocumentDisconnects>();

  // record counts one disconnect of the Document, or of one Actor on it.
  record(documentId: string, actorId?: string): void {
    const entry = this.#documents.get(documentId);
    if (entry === undefined) {
      return;
    }
    if (actorId === undefined) {
      entry.count += 1;
      return;
    }
    entry.actors.set(actorId, (entry.actors.get(actorId) ?? 0) + 1);
  }

  // mark holds the Document's counts until the returned mark is released.
  mark(documentId: string, actorId: string): DisconnectMark {
    let entry = this.#documents.get(documentId);
    if (entry === undefined) {
      entry = { count: 0, actors: new Map(), holders: 0 };
      this.#documents.set(documentId, entry);
    }
    entry.holders += 1;
    const held = entry;
    let released = false;
    return {
      document: held.count,
      actor: held.actors.get(actorId) ?? 0,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        held.holders -= 1;
        if (held.holders === 0 && this.#documents.get(documentId) === held) {
          this.#documents.delete(documentId);
        }
      },
    };
  }

  // isDisconnected also refuses a released mark whose entry is gone: only a
  // closed connection releases its mark.
  isDisconnected(
    documentId: string,
    actorId: string,
    mark: DisconnectMark,
  ): boolean {
    const entry = this.#documents.get(documentId);
    if (entry === undefined) {
      return true;
    }
    return (
      entry.count !== mark.document ||
      (entry.actors.get(actorId) ?? 0) !== mark.actor
    );
  }

  // size reports how many Documents keep counts.
  get size(): number {
    return this.#documents.size;
  }
}
