import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import PlanPage from "./pages/PlanPage";
import ExecutePage from "./pages/ExecutePage";
import SettingsPage from "./pages/SettingsPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PlanPage />} />
        <Route path="/execute" element={<ExecutePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
