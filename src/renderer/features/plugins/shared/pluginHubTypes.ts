export type PluginHubVisibility = 'all' | 'installed' | 'available';

export interface PluginHubManagerProps {
  searchQuery?: string;
  visibility?: PluginHubVisibility;
}
