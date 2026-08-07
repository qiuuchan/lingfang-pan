import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
  type Dispatch,
  type SetStateAction,
} from 'react';

export type AsyncResourceStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface UseAsyncResourceOptions<T> {
  enabled?: boolean;
  isEmpty?: (data: T) => boolean;
}

export interface UseAsyncResourceResult<T> {
  status: AsyncResourceStatus;
  data: T | null;
  error: Error | null;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | null>>;
}

interface AsyncResourceState<T> {
  status: AsyncResourceStatus;
  data: T | null;
  error: Error | null;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error);
  return new Error('加载失败，请稍后重试。');
}

export function useAsyncResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  dependencies: DependencyList,
  options: UseAsyncResourceOptions<T> = {}
): UseAsyncResourceResult<T> {
  const { enabled = true } = options;
  const loaderRef = useRef(loader);
  const isEmptyRef = useRef(options.isEmpty);
  const requestIdRef = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<AsyncResourceState<T>>({
    status: 'idle',
    data: null,
    error: null,
  });

  loaderRef.current = loader;
  isEmptyRef.current = options.isEmpty;

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!enabled) {
      setState((current) =>
        current.status === 'idle' && current.data === null && current.error === null
          ? current
          : { status: 'idle', data: null, error: null }
      );
      return undefined;
    }

    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });

    void (async () => {
      try {
        const data = await loaderRef.current(controller.signal);
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setState({
          status: isEmptyRef.current?.(data) ? 'empty' : 'ready',
          data,
          error: null,
        });
      } catch (error) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setState({ status: 'error', data: null, error: normalizeError(error) });
      }
    })();

    return () => controller.abort();
  }, [enabled, reloadKey, ...dependencies]);

  const reload = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  const setData = useCallback<Dispatch<SetStateAction<T | null>>>((nextData) => {
    setState((current) => {
      const data =
        typeof nextData === 'function'
          ? (nextData as (previous: T | null) => T | null)(current.data)
          : nextData;
      if (data === null) return { status: 'idle', data: null, error: null };
      return {
        status: isEmptyRef.current?.(data) ? 'empty' : 'ready',
        data,
        error: null,
      };
    });
  }, []);

  return { ...state, reload, setData };
}
