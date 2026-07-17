/**
 * A single shop's storefront: browse its shelf, filter, search, fill a basket.
 *
 * The shop to show is chosen on the ShopsScreen and passed in. Products come from
 * GET /shops/:id/products, which the server restricts to APPROVED shops. Out-of-
 * stock items are shown (marked and sorted last) so the customer sees the real
 * shelf.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { api, imageSrc, type Order, type Product, type Shop, type ShopCategory } from "./api";
import { cartCount, cartItemsTotal, useCart } from "./cart";
import { CartScreen } from "./CartScreen";
import { OrderPlacedScreen } from "./OrderPlacedScreen";
import { OrdersScreen } from "./OrdersScreen";
import { productEmoji, tileTint } from "./shopVisuals";
import { colors, font, radius, shadow, space } from "./theme";

export function BrowseScreen({ shop, onBack }: { shop: Shop; onBack: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cart = useCart();
  const [cartOpen, setCartOpen] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);
  const [ordersOpen, setOrdersOpen] = useState(false);

  // The basket belongs to one shop; only show it while viewing that shop.
  const cartForShop = cart.shopId === shop.id ? cart.lines : [];

  const loadProducts = useCallback(
    async (term: string, cat: string | null) => {
      try {
        setProducts(
          await api.listProducts(shop.id, { search: term || undefined, categoryId: cat ?? undefined }),
        );
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [shop.id],
  );

  useEffect(() => {
    void (async () => {
      setError(null);
      try {
        setCategories(await api.listShopCategories(shop.id));
      } catch (err) {
        setError((err as Error).message);
      }
      await loadProducts("", null);
      setLoading(false);
    })();
  }, [shop.id, loadProducts]);

  // Re-query on filter change, debounced so typing does not fire per keystroke.
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => void loadProducts(search, categoryId), 250);
    return () => clearTimeout(t);
  }, [search, categoryId, loading, loadProducts]);

  async function handleRefresh() {
    await loadProducts(search, categoryId);
  }

  if (loading) {
    return (
      <View style={styles.flex}>
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={onBack} testID="back-to-shops" hitSlop={12}>
              <Text style={styles.back}>‹ Shops</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={styles.loadingText}>Loading the shelf…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack} testID="back-to-shops" hitSlop={12}>
            <Text style={styles.back}>‹ Shops</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setOrdersOpen(true)} testID="open-orders">
            <Text style={styles.headerLink}>My orders</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error && (
        <View style={styles.errorBanner} testID="browse-error">
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={handleRefresh}>
            <Text style={styles.retry}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      <FlatList
        data={products}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            <View style={styles.shopCard}>
              <Text style={styles.shopName} testID="shop-name">
                {shop.shopName}
              </Text>
              <Text style={styles.shopMeta}>
                Open {shop.openingHours} · {shop.productCount} items · Cash on delivery
              </Text>
            </View>

            <View style={styles.searchWrap}>
              <Text style={styles.searchIcon}>🔍</Text>
              <TextInput
                style={styles.search}
                value={search}
                onChangeText={setSearch}
                placeholder="Search for an item…"
                placeholderTextColor={colors.faint}
                testID="search-input"
              />
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              <TouchableOpacity
                style={[styles.chip, categoryId === null && styles.chipActive]}
                onPress={() => setCategoryId(null)}
                testID="chip-all"
              >
                <Text style={[styles.chipText, categoryId === null && styles.chipTextActive]}>
                  All
                </Text>
              </TouchableOpacity>

              {categories.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.chip, categoryId === c.id && styles.chipActive]}
                  onPress={() => setCategoryId(c.id)}
                  testID={`chip-${c.name}`}
                >
                  <Text style={[styles.chipText, categoryId === c.id && styles.chipTextActive]}>
                    {c.name} ({c.productCount})
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.product, !item.isAvailable && styles.productOut]} testID="product-item">
            {item.imageUrl ? (
              <Image source={{ uri: imageSrc(item.imageUrl) }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder, { backgroundColor: tileTint(item.id) }]}>
                <Text style={styles.thumbEmoji}>{productEmoji(item.name, item.categoryPath)}</Text>
              </View>
            )}

            <View style={styles.productBody}>
              <Text style={styles.productName} testID="product-name">
                {item.name}
              </Text>
              <Text style={styles.productCategory} numberOfLines={1}>
                {item.categoryPath}
              </Text>
              <Text style={styles.price} testID="product-price">
                {item.price} JOD
              </Text>
            </View>

            <View style={styles.productRight}>
              {!item.isAvailable ? (
                <Text style={styles.outBadge} testID="out-of-stock">
                  Out of stock
                </Text>
              ) : cart.quantityOf(item.id) > 0 ? (
                <View style={styles.stepper}>
                  <TouchableOpacity
                    style={styles.stepButton}
                    onPress={() => cart.remove(item.id)}
                    testID={`minus-${item.name}`}
                  >
                    <Text style={styles.stepText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.stepQty} testID={`qty-${item.name}`}>
                    {cart.quantityOf(item.id)}
                  </Text>
                  <TouchableOpacity
                    style={styles.stepButton}
                    onPress={() => cart.add(item, shop.id)}
                    testID={`plus-${item.name}`}
                  >
                    <Text style={styles.stepText}>+</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.addButton}
                  onPress={() => cart.add(item, shop.id)}
                  testID={`add-${item.name}`}
                >
                  <Text style={styles.addButtonText}>Add</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.centered} testID="no-results">
            <Text style={styles.emptyEmoji}>🔍</Text>
            <Text style={styles.emptyTitle}>Nothing found</Text>
            <Text style={styles.emptyBody}>Try a different search or category.</Text>
          </View>
        }
      />

      {/* Basket bar — only present once this shop's basket has something in it. */}
      {cartForShop.length > 0 && !cartOpen && (
        <TouchableOpacity style={styles.basketBar} onPress={() => setCartOpen(true)} testID="basket-bar">
          <View style={styles.basketCountWrap}>
            <Text style={styles.basketCount} testID="basket-count">
              {cartCount(cartForShop)}
            </Text>
          </View>
          <Text style={styles.basketLabel}>View basket</Text>
          <Text style={styles.basketTotal} testID="basket-total">
            {cartItemsTotal(cartForShop)} JOD
          </Text>
        </TouchableOpacity>
      )}

      <CartScreen
        visible={cartOpen}
        lines={cartForShop}
        shopId={shop.id}
        shopName={shop.shopName}
        onClose={() => setCartOpen(false)}
        onAdd={(productId) => {
          const product = products.find((p) => p.id === productId);
          if (product) cart.add(product, shop.id);
        }}
        onRemove={cart.remove}
        onOrderPlaced={(order) => {
          cart.clear();
          setCartOpen(false);
          setPlacedOrder(order);
        }}
      />

      <OrderPlacedScreen
        order={placedOrder}
        onDone={() => {
          setPlacedOrder(null);
          void loadProducts(search, categoryId);
        }}
      />

      <OrdersScreen visible={ordersOpen} onClose={() => setOrdersOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl },
  loadingText: { marginTop: space.md, color: colors.muted, ...font.small },

  header: {
    backgroundColor: colors.brandDarker,
    paddingTop: 54,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  back: { color: "#ffffff", ...font.h3, fontWeight: "700" },
  headerLink: { color: "#a7f3d0", ...font.small, fontWeight: "700" },

  errorBanner: {
    backgroundColor: colors.dangerSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.dangerBorder,
    padding: space.md,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  errorText: { color: colors.danger, ...font.small, flex: 1 },
  retry: { ...font.small, color: colors.danger, fontWeight: "800" },

  listContent: { padding: space.md, paddingBottom: 96 },

  shopCard: {
    backgroundColor: colors.brandSoft,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colors.brandBorder,
  },
  shopName: { ...font.h1, color: colors.ink },
  shopMeta: { ...font.small, color: colors.ok, marginTop: 3, fontWeight: "600" },

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    marginTop: space.md,
    ...shadow.card,
  },
  searchIcon: { fontSize: 14, marginRight: 6, opacity: 0.5 },
  search: { flex: 1, paddingVertical: 11, ...font.body, color: colors.ink },

  chips: { gap: space.sm, paddingVertical: space.md },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { ...font.small, color: colors.inkSoft, fontWeight: "700" },
  chipTextActive: { color: "#ffffff" },

  product: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.md,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    ...shadow.card,
  },
  productOut: { opacity: 0.62 },
  thumb: { width: 60, height: 60, borderRadius: radius.md, backgroundColor: colors.bg },
  thumbPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.line,
  },
  thumbEmoji: { fontSize: 28 },
  productBody: { flex: 1, marginLeft: space.md },
  productName: { ...font.h3, color: colors.ink },
  productCategory: { ...font.small, color: colors.muted, marginTop: 2 },
  price: { ...font.bodyStrong, color: colors.accent, marginTop: 4 },
  productRight: { alignItems: "flex-end", marginLeft: space.sm },
  outBadge: {
    ...font.tiny,
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: "hidden",
  },

  addButton: {
    paddingHorizontal: space.lg,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.brand,
    ...shadow.card,
  },
  addButtonText: { color: "#ffffff", ...font.small, fontWeight: "800" },

  stepper: { flexDirection: "row", alignItems: "center" },
  stepButton: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.brandBorder,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brandSoft,
  },
  stepText: { fontSize: 18, fontWeight: "800", color: colors.brand, lineHeight: 20 },
  stepQty: { width: 32, textAlign: "center", ...font.bodyStrong, color: colors.ink },

  basketBar: {
    position: "absolute",
    left: space.md,
    right: space.md,
    bottom: 22,
    backgroundColor: colors.brand,
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    ...shadow.bar,
  },
  basketCountWrap: {
    backgroundColor: "rgba(255,255,255,0.22)",
    borderRadius: radius.pill,
    minWidth: 26,
    paddingVertical: 3,
    paddingHorizontal: 6,
    alignItems: "center",
  },
  basketCount: { ...font.small, color: "#ffffff", fontWeight: "800" },
  basketLabel: { ...font.body, color: "#ffffff", fontWeight: "800", flex: 1, marginLeft: space.md },
  basketTotal: { ...font.body, color: "#ffffff", fontWeight: "800" },

  emptyEmoji: { fontSize: 40, marginBottom: space.sm },
  emptyTitle: { ...font.h2, color: colors.ink },
  emptyBody: { ...font.small, color: colors.muted, marginTop: 4, textAlign: "center" },
});
