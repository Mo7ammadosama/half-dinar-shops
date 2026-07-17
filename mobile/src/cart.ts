/**
 * The cart.
 *
 * Deliberately holds only product ids and quantities plus a *display* price.
 * The display price is for showing a running total on screen — it is never sent
 * to the server, which reads the real price from the database at order time.
 * That way a stale or tampered cart can never affect what the customer is
 * charged.
 */
import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Product } from "./api";

const CART_KEY = "halfdinar.customer.cart";

export interface CartLine {
  productId: string;
  name: string;
  /** Shown in the cart only. The server re-reads the real price when ordering. */
  displayPrice: string;
  imageUrl: string | null;
  quantity: number;
}

/** Adds to a fixed-2 money string without floats. Values are small and JOD has 2dp. */
function addMoney(a: string, b: string): string {
  const cents = Math.round(parseFloat(a) * 100) + Math.round(parseFloat(b) * 100);
  return (cents / 100).toFixed(2);
}

/** Multiplies a fixed-2 money string by a whole quantity, without floats. */
export function multiplyMoney(amount: string, quantity: number): string {
  const cents = Math.round(parseFloat(amount) * 100) * quantity;
  return (cents / 100).toFixed(2);
}

export function cartItemsTotal(lines: CartLine[]): string {
  return lines.reduce((sum, l) => addMoney(sum, multiplyMoney(l.displayPrice, l.quantity)), "0.00");
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((n, l) => n + l.quantity, 0);
}

/** The persisted cart shape. `shopId` binds a basket to a single shop. */
interface StoredCart {
  shopId: string | null;
  lines: CartLine[];
}

/** Cart state, persisted so it survives closing the app. */
export function useCart() {
  const [lines, setLines] = useState<CartLine[]>([]);
  // Which shop this basket belongs to. A basket is for ONE shop at a time: the
  // customer can browse several shops, but the items they are ordering, and the
  // shop the order is placed against, must be a single shop.
  const [shopId, setShopId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(CART_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as StoredCart | CartLine[];
          // Migrate the old array-only format (pre shop-scoping) transparently.
          if (Array.isArray(parsed)) {
            setLines(parsed);
            setShopId(null);
          } else {
            setLines(parsed.lines ?? []);
            setShopId(parsed.shopId ?? null);
          }
        }
      } catch {
        // A corrupt cart must not block the app — start empty.
      }
      setLoaded(true);
    })();
  }, []);

  // Persist on every change, but not before the initial load has happened, or
  // the empty starting state would wipe the saved cart.
  useEffect(() => {
    if (!loaded) return;
    const payload: StoredCart = { shopId, lines };
    void AsyncStorage.setItem(CART_KEY, JSON.stringify(payload)).catch(() => {});
  }, [lines, shopId, loaded]);

  /**
   * Adds one of a product to the basket for the given shop.
   *
   * If the basket currently belongs to a different shop, it is replaced — you
   * start a fresh basket at the shop you are now buying from. In the pilot a
   * customer buys from one shop per session, so this only guards the edge case
   * of switching shops mid-basket rather than being a routine path.
   */
  const add = useCallback(
    (product: Product, forShopId?: string) => {
      if (forShopId && forShopId !== shopId) {
        // Switching shops (or first add): begin a new basket for this shop.
        setShopId(forShopId);
        setLines([
          {
            productId: product.id,
            name: product.name,
            displayPrice: product.price,
            imageUrl: product.imageUrl,
            quantity: 1,
          },
        ]);
        return;
      }

      setLines((current) => {
        const existing = current.find((l) => l.productId === product.id);
        if (existing) {
          return current.map((l) =>
            l.productId === product.id ? { ...l, quantity: l.quantity + 1 } : l,
          );
        }
        return [
          ...current,
          {
            productId: product.id,
            name: product.name,
            displayPrice: product.price,
            imageUrl: product.imageUrl,
            quantity: 1,
          },
        ];
      });
    },
    [shopId],
  );

  /** Decrements, removing the line when it reaches zero. */
  const remove = useCallback((productId: string) => {
    setLines((current) =>
      current
        .map((l) => (l.productId === productId ? { ...l, quantity: l.quantity - 1 } : l))
        .filter((l) => l.quantity > 0),
    );
  }, []);

  const removeLine = useCallback((productId: string) => {
    setLines((current) => current.filter((l) => l.productId !== productId));
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setShopId(null);
  }, []);

  const quantityOf = useCallback(
    (productId: string) => lines.find((l) => l.productId === productId)?.quantity ?? 0,
    [lines],
  );

  return { lines, shopId, loaded, add, remove, removeLine, clear, quantityOf };
}
