import { MainLayout } from './components';
import { BootstrapEffects } from './components/BootstrapEffects';
import { SyncScheduler } from './components/sync/SyncScheduler';

function App() {
  return (
    <>
      <BootstrapEffects />
      <SyncScheduler />
      <MainLayout />
    </>
  );
}

export default App;
