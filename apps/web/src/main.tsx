import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { engine } from "./engine/client";
import * as actions from "./state/actions";
import { getState, setState } from "./state/store";
import { VERSION } from "./lib/version";
import "./styles.css";

// Console and test handle: e.g. wavebench.actions.openExample("with-time").
Object.assign(window, { wavebench: { version: VERSION, engine, actions, getState, setState } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
