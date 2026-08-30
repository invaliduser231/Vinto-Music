import { Suspense } from 'react';
import { VintoApp } from '@/components/vinto/VintoApp';

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <VintoApp />
    </Suspense>
  );
}