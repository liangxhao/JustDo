export type ArtifactType = 'html' | 'svg' | 'mermaid' | 'react' | 'code';

export interface Artifact {
  id: string;
  messageId: string;
  conversationId: string;
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  createdAt: number;
}

export interface ArtifactMarker {
  type: ArtifactType;
  title: string;
  content: string;
  language?: string;
  fullMatch: string;
}
