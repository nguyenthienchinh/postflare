import { api } from "./api";
import { useSession } from "./session";
import { useFetch } from "./useFetch";

/** Running server version and the newest release (instance admins only; undefined for everyone else). */
export function useUpdateStatus() {
  const { canInstance } = useSession();
  return useFetch(canInstance("instance.settings.manage") ? "updates" : null, api.updates.get, ["updates"]);
}
