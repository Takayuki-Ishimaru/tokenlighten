import {AsyncLocalStorage} from "node:async_hooks";
type Observer = (workspace:string,token:string,previous:number,next:number) => void;
const observer = new AsyncLocalStorage<Observer>();
/** Audit successful task-record CAS writes without changing their behavior. */
export function observeReadCallTaskMutations<T>(run:()=>Promise<T>, note:Observer): Promise<T> {
  return observer.run(note,run);
}
export function noteReadCallTaskMutation(workspace:string,token:string,previous:number,next:number): void {
  try {observer.getStore()?.(workspace,token,previous,next);} catch { /* audit cannot break a task write */ }
}
