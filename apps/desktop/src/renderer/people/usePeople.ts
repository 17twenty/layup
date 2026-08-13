import { useEffect, useState } from 'react';
import type { PeopleResponse } from '../../shared/ipc';

/**
 * People come from realtime presence pushes, not polling: the list is fresh
 * because the control plane told us, not because we asked again.
 */
export function usePeople(): { people: PeopleResponse['people']; loaded: boolean } {
  const [people, setPeople] = useState<PeopleResponse['people']>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = window.layup.people.onChanged((payload) => {
      if (!cancelled) {
        setPeople(payload.people);
        setLoaded(true);
      }
    });

    void window.layup.people
      .list()
      .then((payload) => {
        if (!cancelled) {
          setPeople((current) => (current.length > 0 ? current : payload.people));
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { people, loaded };
}
