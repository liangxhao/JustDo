import DataDirectoryCard from './DataDirectoryCard';
import SessionStorageCard from './SessionStorageCard';

export default function SessionStoragePage() {
  return (
    <div className="space-y-6">
      <DataDirectoryCard />
      <SessionStorageCard />
    </div>
  );
}
