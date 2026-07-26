/**
 * Product management with camera-driven AI entry.
 *
 * The shopkeeper photographs an item and its name, category and price fill
 * themselves in — the whole reason this is a phone app and not a web form. The
 * photo is uploaded (and stored) AND read by the AI in one action; recognition
 * is a free, optional bonus on a photo the merchant was adding anyway.
 *
 * Rules carried over from the web dashboard, deliberately:
 *  - The AI suggestion ONLY fills EMPTY fields — never overwrites what the
 *    merchant typed, or a helpful feature becomes one that destroys their work.
 *  - The suggestion is presented as something to CHECK. Confidence is shown, so
 *    a weak guess looks weak instead of quietly sending a wrong price to a
 *    customer.
 *
 * Phase 11 (daily-use polish): an out-of-stock warning banner, availability +
 * sort filters over the loaded list, a confirmation step before Delete (it was
 * one careless tap from destroying a product), Undo on the availability toggle,
 * and a success toast after every action so nothing completes silently.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  api,
  imageSrc,
  type Category,
  type Product,
  type ProductSuggestion,
} from "./api";
import { pickFromLibrary, takePhoto, type CaptureResult } from "./camera";
import { Chips } from "./Chips";
import { Toast, type ToastState } from "./Toast";
import { colors, font, radius, shadow, space } from "./theme";

const EMPTY_FORM = { name: "", price: "", categoryId: "", imageUrl: "" };

type AvailFilter = "all" | "in" | "out";
type SortBy = "recent" | "name" | "price";

export function ProductsScreen() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [availFilter, setAvailFilter] = useState<AvailFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("recent");

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // The add/edit form is hidden behind a toggle so the tab opens on the LIST —
  // the shopkeeper's first question is "what do I have", not "add something".
  const [showForm, setShowForm] = useState(false);
  // Distinct from `error` (which also carries form/validation messages): true
  // when the product list itself failed to load, so we can offer a Retry instead
  // of a bare empty state (the cold-backend case).
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<ProductSuggestion | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const loadProducts = useCallback(async (term: string) => {
    try {
      setProducts(await api.listProducts(term || undefined));
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setCategories(await api.categories());
        await loadProducts("");
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [loadProducts]);

  // Debounce search so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void loadProducts(search), 250);
    return () => clearTimeout(t);
  }, [search, loadProducts]);

  const outOfStockCount = useMemo(
    () => products.filter((p) => !p.isAvailable).length,
    [products],
  );
  const inStockCount = products.length - outOfStockCount;

  // Availability filter + sort are applied client-side over the already-loaded
  // list (search stays server-side). Keeps the list snappy without extra fetches.
  const visibleProducts = useMemo(() => {
    let list = products;
    if (availFilter === "in") list = list.filter((p) => p.isAvailable);
    else if (availFilter === "out") list = list.filter((p) => !p.isAvailable);
    const sorted = [...list];
    if (sortBy === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === "price") sorted.sort((a, b) => Number(a.price) - Number(b.price));
    else sorted.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return sorted;
  }, [products, availFilter, sortBy]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setSuggestion(null);
    setShowCategories(false);
    setShowForm(false);
  }

  async function handleSubmit() {
    if (!form.name.trim() || !form.price || !form.categoryId) {
      setError(t("products.errRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        price: Number(form.price),
        categoryId: form.categoryId,
        ...(form.imageUrl ? { imageUrl: form.imageUrl } : {}),
      };
      const wasEditing = Boolean(editingId);
      if (editingId) {
        await api.updateProduct(editingId, payload);
        // Editing is a one-off: close the form and return to the list.
        resetForm();
      } else {
        await api.createProduct(payload);
        // Adding: keep the form open with cleared fields so the shopkeeper can
        // add several items in a row without re-opening it each time.
        setForm(EMPTY_FORM);
        setSuggestion(null);
        setShowCategories(false);
      }
      await loadProducts(search);
      setToast({ message: wasEditing ? t("products.toastSaved") : t("products.toastAdded"), tone: "ok" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Handles a captured/picked image: upload it, then read it.
   *
   * Upload failure is surfaced (the photo did not save). Recognition failure is
   * silent — the photo is already saved, so the merchant just types, exactly as
   * before.
   */
  async function handleCapture(result: CaptureResult) {
    if (result.status === "denied") {
      setError(t("products.errCameraDenied"));
      return;
    }
    if (result.status === "unavailable") {
      setError(result.reason);
      return;
    }
    if (result.status === "cancelled") return;

    const image = result.image;
    setError(null);
    setSuggestion(null);
    setUploading(true);
    try {
      const { imageUrl } = await api.uploadImage(image);
      setForm((f) => ({ ...f, imageUrl }));
    } catch (err) {
      setError((err as Error).message);
      setUploading(false);
      return;
    }
    setUploading(false);

    setSuggesting(true);
    try {
      const result2 = await api.suggestFromPhoto(image);
      setSuggestion(result2);
      // Only fill EMPTY fields — never overwrite the merchant's own input.
      setForm((f) => ({
        ...f,
        name: f.name || result2.name,
        price: f.price || result2.price || "",
        categoryId: f.categoryId || result2.categoryId || "",
      }));
    } catch {
      // Silent: the photo saved, and typing still works.
    } finally {
      setSuggesting(false);
    }
  }

  function startEdit(product: Product) {
    setEditingId(product.id);
    setShowForm(true);
    setConfirmDeleteId(null);
    setForm({
      name: product.name,
      price: product.price,
      categoryId: product.categoryId,
      imageUrl: product.imageUrl ?? "",
    });
    setSuggestion(null);
  }

  async function handleToggle(product: Product) {
    setError(null);
    const next = !product.isAvailable;
    try {
      await api.setAvailability(product.id, next);
      await loadProducts(search);
      // Undo is safe here: availability is a single reversible flag that does not
      // touch any order or notify a customer.
      setToast({
        message: next
          ? t("products.toastBackInStock", { name: product.name })
          : t("products.toastMarkedOut", { name: product.name }),
        tone: "ok",
        actionLabel: t("products.undo"),
        onAction: async () => {
          try {
            await api.setAvailability(product.id, product.isAvailable);
            await loadProducts(search);
          } catch (err) {
            setError((err as Error).message);
          }
        },
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(product: Product) {
    setError(null);
    try {
      await api.deleteProduct(product.id);
      setConfirmDeleteId(null);
      await loadProducts(search);
      if (editingId === product.id) resetForm();
      setToast({ message: t("products.toastDeleted", { name: product.name }), tone: "danger" });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const selectedCategory = categories.find((c) => c.id === form.categoryId);

  return (
    <View style={styles.flex}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        {error && (
          <View style={styles.errorBox} testID="products-error">
            <Text style={styles.errorText}>{loadFailed ? t("products.loadFailed") : error}</Text>
            {loadFailed && (
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => void loadProducts(search)}
                testID="products-retry"
              >
                <Text style={styles.retryButtonText}>{t("products.retry")}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

      {/* Add-product toggle — keeps the tab opening on the LIST, form on demand. */}
      {!showForm && (
        <TouchableOpacity
          style={styles.addToggle}
          onPress={() => setShowForm(true)}
          testID="show-add-form"
        >
          <Text style={styles.addToggleText}>{t("products.addNewProduct")}</Text>
        </TouchableOpacity>
      )}

      {/* Add / edit form */}
      {showForm && (
      <View style={styles.card}>
        <View style={styles.formHeadRow}>
          <Text style={styles.cardTitle}>{editingId ? t("products.editProduct") : t("products.addProduct")}</Text>
          {!editingId && (
            <TouchableOpacity onPress={resetForm} testID="close-add-form">
              <Text style={styles.closeFormText}>{t("products.closeForm")}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Photo → AI entry */}
        <View style={styles.photoRow}>
          {form.imageUrl ? (
            <Image source={{ uri: imageSrc(form.imageUrl) }} style={styles.photoPreview} />
          ) : (
            <View style={[styles.photoPreview, styles.photoPlaceholder]}>
              <Text style={styles.photoPlaceholderText}>{t("products.noPhoto")}</Text>
            </View>
          )}
          <View style={styles.photoButtons}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={async () => handleCapture(await takePhoto())}
              disabled={uploading || suggesting}
              testID="take-photo"
            >
              <Text style={styles.secondaryButtonText}>{t("products.takePhoto")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={async () => handleCapture(await pickFromLibrary())}
              disabled={uploading || suggesting}
              testID="pick-photo"
            >
              <Text style={styles.secondaryButtonText}>{t("products.gallery")}</Text>
            </TouchableOpacity>
          </View>
        </View>
        {uploading && <Text style={styles.muted}>{t("products.uploading")}</Text>}
        {suggesting && (
          <Text style={styles.muted} testID="suggesting">
            {t("products.reading")}
          </Text>
        )}

        {suggestion && !suggesting && (
          <View
            style={[styles.suggestion, suggestion.confidence < 0.5 && styles.suggestionUnsure]}
            testID="ai-suggestion"
          >
            <Text style={styles.suggestionHead}>
              {suggestion.confidence < 0.5 ? t("products.aiUnsure") : t("products.aiFilled")}
            </Text>
            <Text style={styles.suggestionMeta} testID="ai-confidence">
              {t("products.aiConfidence", {
                pct: Math.round(suggestion.confidence * 100),
                note:
                  suggestion.provider === "mock"
                    ? t("products.aiDemoNote")
                    : t("products.aiCheckNote"),
              })}
            </Text>
          </View>
        )}

        <Text style={styles.label}>{t("products.productName")}</Text>
        <TextInput
          style={styles.input}
          value={form.name}
          onChangeText={(name) => setForm((f) => ({ ...f, name }))}
          placeholder="Dish Sponge (2 pcs)"
          placeholderTextColor={colors.faint}
          testID="product-name"
        />

        <Text style={styles.label}>{t("products.priceLabel")}</Text>
        <TextInput
          style={styles.input}
          value={form.price}
          onChangeText={(price) => setForm((f) => ({ ...f, price }))}
          placeholder="0.50"
          placeholderTextColor={colors.faint}
          keyboardType="decimal-pad"
          testID="product-price"
        />

        <Text style={styles.label}>{t("products.category")}</Text>
        <TouchableOpacity
          style={styles.input}
          onPress={() => setShowCategories((s) => !s)}
          testID="category-picker"
        >
          <Text style={selectedCategory ? styles.pickerValue : styles.pickerPlaceholder}>
            {selectedCategory ? selectedCategory.path : t("products.chooseCategory")}
          </Text>
        </TouchableOpacity>
        {showCategories && (
          <View style={styles.categoryList}>
            {categories.map((c) => (
              <TouchableOpacity
                key={c.id}
                style={[styles.categoryOption, form.categoryId === c.id && styles.categoryOptionActive]}
                onPress={() => {
                  setForm((f) => ({ ...f, categoryId: c.id }));
                  setShowCategories(false);
                }}
                testID={`category-${c.id}`}
              >
                <Text
                  style={[
                    styles.categoryOptionText,
                    form.categoryId === c.id && styles.categoryOptionTextActive,
                  ]}
                >
                  {c.path}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={styles.formActions}>
          <TouchableOpacity
            style={[styles.button, (busy || uploading) && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={busy || uploading}
            testID="save-product"
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>
                {editingId ? t("products.saveChanges") : t("products.addProductBtn")}
              </Text>
            )}
          </TouchableOpacity>
          {editingId && (
            <TouchableOpacity style={styles.ghostButton} onPress={resetForm} testID="cancel-edit">
              <Text style={styles.ghostButtonText}>{t("products.cancel")}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
      )}

      {/* Product list */}
      <View style={styles.listHead}>
        <Text style={styles.cardTitle}>{t("products.yourProducts", { count: products.length })}</Text>
      </View>

      {/* Out-of-stock warning — the thing a shopkeeper most needs to notice. */}
      {outOfStockCount > 0 && (
        <TouchableOpacity
          style={styles.stockWarn}
          onPress={() => setAvailFilter(availFilter === "out" ? "all" : "out")}
          testID="stock-warning"
        >
          <Text style={styles.stockWarnText}>
            {t("products.stockWarn", {
              out: outOfStockCount,
              total: products.length,
              action: availFilter === "out" ? t("products.stockWarnShowAll") : t("products.stockWarnReview"),
            })}
          </Text>
        </TouchableOpacity>
      )}

      <TextInput
        style={[styles.input, styles.searchInput]}
        value={search}
        onChangeText={setSearch}
        placeholder={t("products.searchPlaceholder")}
        placeholderTextColor={colors.faint}
        testID="product-search"
      />

      <Chips<AvailFilter>
        testIDPrefix="prodfilter"
        value={availFilter}
        onChange={setAvailFilter}
        options={[
          { value: "all", label: t("products.filterAll"), count: products.length },
          { value: "in", label: t("products.filterIn"), count: inStockCount },
          { value: "out", label: t("products.filterOut"), count: outOfStockCount },
        ]}
      />
      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>{t("products.sort")}</Text>
        <Chips<SortBy>
          testIDPrefix="prodsort"
          value={sortBy}
          onChange={setSortBy}
          options={[
            { value: "recent", label: t("products.sortRecent") },
            { value: "name", label: t("products.sortName") },
            { value: "price", label: t("products.sortPrice") },
          ]}
        />
      </View>

      {products.length === 0 ? (
        <Text style={styles.emptyText} testID="no-products">
          {t("products.noProducts")}
        </Text>
      ) : visibleProducts.length === 0 ? (
        <Text style={styles.emptyText} testID="no-products-filtered">
          {t("products.noProductsFiltered")}
        </Text>
      ) : (
        visibleProducts.map((p) => (
          <View key={p.id} style={styles.productRow} testID="product-row">
            {p.imageUrl ? (
              <Image source={{ uri: imageSrc(p.imageUrl) }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder]}>
                <Text style={styles.thumbEmoji}>🛒</Text>
              </View>
            )}
            <View style={styles.productInfo}>
              <Text style={styles.productName} testID="product-row-name">
                {p.name}
              </Text>
              <Text style={styles.productMeta}>{p.categoryPath}</Text>
              <Text style={styles.productPrice}>{t("products.priceUnit", { price: p.price })}</Text>
            </View>
            <View style={styles.productActions}>
              <TouchableOpacity
                style={[styles.pill, p.isAvailable ? styles.pillOn : styles.pillOff]}
                onPress={() => handleToggle(p)}
                testID={`toggle-${p.id}`}
              >
                <Text style={p.isAvailable ? styles.pillOnText : styles.pillOffText}>
                  {p.isAvailable ? t("products.inStock") : t("products.outOfStock")}
                </Text>
              </TouchableOpacity>
              {confirmDeleteId === p.id ? (
                <View style={styles.confirmDelete} testID={`confirm-delete-box-${p.id}`}>
                  <Text style={styles.confirmDeleteText}>{t("products.deleteThis")}</Text>
                  <View style={styles.rowButtons}>
                    <TouchableOpacity onPress={() => handleDelete(p)} testID={`confirm-delete-${p.id}`}>
                      <Text style={[styles.linkAction, styles.linkDanger]}>{t("products.yesDelete")}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setConfirmDeleteId(null)} testID={`cancel-delete-${p.id}`}>
                      <Text style={styles.linkAction}>{t("products.keep")}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View style={styles.rowButtons}>
                  <TouchableOpacity onPress={() => startEdit(p)} testID={`edit-${p.id}`}>
                    <Text style={styles.linkAction}>{t("products.edit")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setConfirmDeleteId(p.id)} testID={`delete-${p.id}`}>
                    <Text style={[styles.linkAction, styles.linkDanger]}>{t("products.delete")}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        ))
      )}
        <View style={{ height: space.xxl }} />
      </ScrollView>
      <Toast state={toast} onDismiss={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    marginBottom: space.lg,
    ...shadow.card,
  },
  cardTitle: { ...font.h2, color: colors.ink, marginBottom: space.md },
  formHeadRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  closeFormText: { ...font.small, color: colors.muted, fontWeight: "700", marginBottom: space.md },
  addToggle: {
    backgroundColor: colors.brand,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: space.lg,
  },
  addToggleText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  retryButton: {
    alignSelf: "flex-start",
    marginTop: space.sm,
    backgroundColor: colors.danger,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  retryButtonText: { color: "#fff", fontWeight: "700" },
  photoRow: { flexDirection: "row", gap: space.md, alignItems: "center" },
  photoPreview: { width: 84, height: 84, borderRadius: radius.md, backgroundColor: colors.cardAlt },
  photoPlaceholder: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line },
  photoPlaceholderText: { ...font.tiny, color: colors.faint },
  photoButtons: { flex: 1, gap: space.sm },
  secondaryButton: {
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: colors.brandBorder,
    borderRadius: radius.sm,
    paddingVertical: space.md,
    alignItems: "center",
  },
  secondaryButtonText: { color: colors.brand, fontWeight: "700" },
  muted: { ...font.small, color: colors.muted, marginTop: space.sm },
  suggestion: {
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: colors.brandBorder,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.md,
  },
  suggestionUnsure: { backgroundColor: colors.warnSoft, borderColor: colors.accentBorder },
  suggestionHead: { ...font.bodyStrong, color: colors.ink },
  suggestionMeta: { ...font.small, color: colors.inkSoft, marginTop: space.xs },
  label: { ...font.h3, color: colors.ink, marginTop: space.md, marginBottom: space.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: "#fff",
  },
  searchInput: { marginBottom: space.md },
  stockWarn: {
    backgroundColor: colors.warnSoft,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.md,
  },
  stockWarnText: { ...font.small, color: colors.warn, fontWeight: "700" },
  sortRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  sortLabel: { ...font.small, color: colors.muted, marginBottom: space.md },
  pickerValue: { fontSize: 16, color: colors.ink },
  pickerPlaceholder: { fontSize: 16, color: colors.faint },
  categoryList: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    marginTop: space.xs,
    overflow: "hidden",
  },
  categoryOption: { paddingHorizontal: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
  categoryOptionActive: { backgroundColor: colors.brandSoft },
  categoryOptionText: { fontSize: 15, color: colors.inkSoft },
  categoryOptionTextActive: { color: colors.brand, fontWeight: "700" },
  formActions: { flexDirection: "row", gap: space.md, marginTop: space.lg, alignItems: "center" },
  button: {
    flex: 1,
    backgroundColor: colors.brand,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  ghostButton: { paddingVertical: 14, paddingHorizontal: space.lg },
  ghostButtonText: { color: colors.muted, fontWeight: "700" },
  listHead: { marginBottom: space.sm },
  emptyText: { ...font.body, color: colors.muted, textAlign: "center", padding: space.xl },
  productRow: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
    ...shadow.card,
  },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.cardAlt },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  thumbEmoji: { fontSize: 24 },
  productInfo: { flex: 1, marginLeft: space.md },
  productName: { ...font.bodyStrong, color: colors.ink },
  productMeta: { ...font.small, color: colors.muted, marginTop: 2 },
  productPrice: { ...font.bodyStrong, color: colors.accent, marginTop: space.xs },
  productActions: { alignItems: "flex-end", justifyContent: "space-between" },
  pill: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs, borderWidth: 1 },
  pillOn: { backgroundColor: colors.okSoft, borderColor: colors.brandBorder },
  pillOff: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerBorder },
  pillOnText: { ...font.tiny, color: colors.ok },
  pillOffText: { ...font.tiny, color: colors.danger },
  rowButtons: { flexDirection: "row", gap: space.md, marginTop: space.sm },
  confirmDelete: { alignItems: "flex-end", marginTop: space.sm },
  confirmDeleteText: { ...font.tiny, color: colors.danger },
  linkAction: { ...font.small, color: colors.brand, fontWeight: "700" },
  linkDanger: { color: colors.danger },
  errorBox: {
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.md,
  },
  errorText: { color: colors.danger, fontSize: 13 },
});
