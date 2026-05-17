import { useCallback, useState } from 'react';

export function useTweaks<T extends Record<string, any>>(defaults: T): [T, (k: keyof T | Partial<T>, v?: any) => void] {
  const [values, setValues] = useState<T>(defaults);
  const setTweak = useCallback((keyOrEdits: any, val?: any) => {
    const edits =
      typeof keyOrEdits === 'object' && keyOrEdits !== null
        ? keyOrEdits
        : { [keyOrEdits]: val };
    setValues((prev: any) => ({ ...prev, ...edits }));
  }, []);
  return [values, setTweak];
}
