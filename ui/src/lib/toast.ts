// Toasts (sonner), shared by the desk and the Projects home without pulling in either app's store.
import { toast as sonner } from 'sonner';
export function toast(msg: unknown, err = false) {
  if (err) sonner.error(String(msg), { duration: 6000 }); else sonner.success(String(msg), { duration: 3600 });
}
