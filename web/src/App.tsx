import { useEffect, useState } from "react";
import { DEFAULT_SERVER_URL, clearAll, loadCfg, saveCfg, type Config } from "./config";
import { SyncManager } from "./store";
import { Setup } from "./components/Setup";
import { Notes } from "./components/Notes";

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(() => loadCfg());
  const [manager, setManager] = useState<SyncManager | null>(null);

  useEffect(() => {
    if (!cfg) {
      setManager(null);
      return;
    }
    const m = new SyncManager(cfg);
    m.start();
    setManager(m);
    return () => m.stop();
  }, [cfg]);

  if (!cfg || !manager) {
    return (
      <Setup
        defaultServerUrl={DEFAULT_SERVER_URL}
        onConnect={(c) => {
          saveCfg(c);
          setCfg(c);
        }}
      />
    );
  }
  return (
    <Notes
      manager={manager}
      onNewCfg={(c) => {
        // Stop pending sync/import writes before clearing or replacing login
        // data, rather than waiting for the effect cleanup after the render.
        manager.stop();
        if (c) saveCfg(c);
        else clearAll();
        setCfg(c);
      }}
    />
  );
}
