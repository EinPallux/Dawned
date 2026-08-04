/** Screen router: boot → login → select → create → world (docs/tech/ARCHITECTURE.md §4). */

import { useEffect } from 'react';
import { useApp, type Screen } from './store.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { CharacterSelectScreen } from './screens/CharacterSelectScreen.js';
import { CharacterCreateScreen } from './screens/CharacterCreateScreen.js';
import { WorldScreen } from './screens/WorldScreen.js';
import { BuildWatch } from './components/BuildWatch.js';

export const App = (): React.JSX.Element | null => {
  const { screen, bootstrap } = useApp();

  useEffect(() => {
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once at mount
  }, []);

  // The stale-build notice rides above every screen: a deploy can land while
  // you are staring at the login form just as easily as mid-fight.
  return (
    <>
      <BuildWatch />
      {screenFor(screen)}
    </>
  );
};

const screenFor = (screen: Screen): React.JSX.Element => {
  switch (screen) {
    case 'boot':
      return (
        <div className="boot-screen">
          <div className="brand">DAWNED</div>
          <div className="boot-screen__pulse" />
        </div>
      );
    case 'login':
      return <LoginScreen />;
    case 'select':
      return <CharacterSelectScreen />;
    case 'create':
      return <CharacterCreateScreen />;
    case 'world':
      return <WorldScreen />;
  }
};
