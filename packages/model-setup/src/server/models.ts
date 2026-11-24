/** Where a host keeps which sources a test call has worked on. */
export interface TestedStore {
  read(): Promise<readonly string[]>;
  write(sources: string[]): Promise<void>;
}

/** The sources a test call has worked on: the setup is done for those, not for the others. */
export class Tested {
  constructor(private readonly store: TestedStore) {}

  async has(source: string): Promise<boolean> {
    return (await this.store.read()).includes(source);
  }

  async mark(source: string): Promise<void> {
    const tested = await this.store.read();
    if (!tested.includes(source)) {
      await this.store.write([...tested, source]);
    }
  }
}
