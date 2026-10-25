export class Queue {
  constructor() {
    throw new Error("BullMQ is unavailable on Workers; use the JOBS binding");
  }
}
