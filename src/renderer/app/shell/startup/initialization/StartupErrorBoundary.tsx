import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Report renderer failures to the owning startup flow instead of choosing another UI. */
export default class StartupErrorBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AppInitialization] Interface failed:', error, info.componentStack);
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
