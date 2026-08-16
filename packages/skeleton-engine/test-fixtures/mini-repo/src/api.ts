// Mini-repo fixture: Express-style API routes
import { add, Calculator } from "./math";

const app = { get: (_path: string, _handler: unknown) => {}, post: (_path: string, _handler: unknown) => {} };

app.get("/health", (req: unknown, res: unknown) => {});

app.post("/calculate", (req: unknown, res: unknown) => {
  const calc = new Calculator();
  calc.accumulate(add(1, 2));
});

export function startServer(port: number): void {
  console.log(`Listening on ${port}`);
}
