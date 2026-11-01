import type { VisualKey } from './assets';
import { FeatureIllustration } from './feature-illustration';

/** The picture at the top of an empty state: decorative, because the title below says it in words. */
export function EmptyStateIllustration({ asset = 'folder' }: { asset?: VisualKey }) {
  return <FeatureIllustration asset={asset} size={72} className="-mb-2" />;
}
