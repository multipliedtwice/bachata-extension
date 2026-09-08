export class WorkflowInterruptedError extends Error {
  constructor(message = "Workflow interrupted") {
    super(message);
    this.name = "WorkflowInterruptedError";
  }
}

export class ProcessTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessTimeoutError";
  }
}
