import { installNativeWidgetMessaging } from '@/libs/openclaw-chat/components/native-widget/messaging';

installNativeWidgetMessaging();

// The existing portal waits for this root. Publish it only after the local
// messaging function is ready, so the first widget cannot race module loading.
const root = document.createElement('div');
root.id = 'workspace-root';
root.style.height = '100vh';
root.style.overflow = 'hidden';
document.body.append(root);
