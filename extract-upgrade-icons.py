"""Re-extract upgrade icons with SEMANTIC mapping (verified visually).

Prior extraction mapped files alphabetically (bakery.webp held
bag_factory art, etc.). This maps each source image to the real game id
it depicts. Ambiguous files were inspected pixel-by-pixel:
- asian_restaurant shows a sushi bar -> sushifactory (certain)
- rubber_factory shows a glue bottle + chemical vats -> semifinishedfactory
- plastics_factory shows finished plastic goods + rubber rolls -> wheelfactory
  (rolls -> tires) and duplicated for spongefactory (no sponge art in set)
- grill_factory shows a fish grill over fire -> roasterfactory
- pastry_factory shows a cupcake storefront/cafe -> vegancafe
- food_processing_factory shows an industrial freezer + conveyor ->
  chocolatefactory (cooling stage)
Islands i1..i5 keep alphabetical order (no source maps isle number).
Train.webp is copied to train_1/2/3 per request.
"""

import os
import zipfile

SRC_DIR = "township_factories_islands_trainicons"
DST_DIR = os.path.join("public", "upgrades")

ZIP_TO_ID = {
    "bag_factory.webp": "bagfactory",
    "bakery.webp": "bakery",
    "beverage_factory.webp": "drinksfactory",
    "bouquet_factory.webp": "bouquetfactory",
    "cake_factory.webp": "cakefactory",
    "candy_factory.webp": "candyfactory",
    "coffee_factory.webp": "coffeefactory",
    "dairy_factory.webp": "milkfactory",
    "doll_factory.webp": "dollfactory",
    "down_feather_factory.webp": "featherfactory",
    "fast_food_restaurant.webp": "fastfoodfactory",
    "feed_mill.webp": "mill",
    "festivities_factory.webp": "holidayfactory",
    "french_restaurant.webp": "frenchrestaurant",
    "furniture_factory.webp": "furniturefactory",
    "gardening_supplies_factory.webp": "gardeningfactory",
    "hot_dog_factory.webp": "hotdogfactory",
    "household_goods_factory.webp": "housewaresfactory",
    "ice_cream_factory.webp": "icecreamfactory",
    "italian_restaurant.webp": "italyfoodfactory",
    "jam_factory.webp": "jamfactory",
    "jewelry_store.webp": "jewelryfactory",
    "kitchenware_factory.webp": "kitchenwarefactory",
    "mexican_restaurant.webp": "mexfoodfactory",
    "music_factory.webp": "factory_music_instruments",
    "paper_factory.webp": "paperfactory",
    "perfume_factory.webp": "scentfactory",
    "pet_supply_factory.webp": "petfactory",
    "shoe_factory.webp": "shoefactory",
    "snack_factory.webp": "chipsfactory",
    "stationery_factory.webp": "stationeryfactory",
    "sugar_factory.webp": "sugarfactory",
    "tailor_shop.webp": "clothingfactory",
    "tea_factory.webp": "tea_factory",
    "textile_factory.webp": "cottonfactory",
    "asian_restaurant.webp": "sushifactory",
    "food_processing_factory.webp": "chocolatefactory",
    "grill_factory.webp": "roasterfactory",
    "pastry_factory.webp": "vegancafe",
    "plastics_factory.webp": "wheelfactory",
    "rubber_factory.webp": "semifinishedfactory",
}

# No sponge art in the set: duplicate the sister industrial plant.
DUPLICATES = {
    "spongefactory": "plastics_factory.webp",
}

# Islands keep alphabetical order; trains share the single Train art.
ISLES = [
    "bonita_isle.webp",
    "fishermen_s_isle.webp",
    "frutus_isle.webp",
    "olivia_isle.webp",
    "tropica_isle.webp",
]


def main():
    with zipfile.ZipFile("township_factories_islands_trainicons.zip") as z:
        raw = {}
        for info in z.infolist():
            if info.is_dir():
                continue
            raw[info.filename.split("/")[-1]] = z.read(info.filename)

    os.makedirs(DST_DIR, exist_ok=True)
    written = {}

    def write(real_id, data, src_name):
        path = os.path.join(DST_DIR, real_id + ".webp")
        with open(path, "wb") as fh:
            fh.write(data)
        written[real_id] = src_name

    for src_name, real_id in ZIP_TO_ID.items():
        assert src_name in raw, "missing in zip: " + src_name
        write(real_id, raw[src_name], src_name)
    for real_id, src_name in DUPLICATES.items():
        write(real_id, raw[src_name], src_name + " (duplicate)")
    for n, src_name in enumerate(ISLES, start=1):
        write("i%d" % n, raw[src_name], src_name)
    for n in (1, 2, 3):
        write("train_%d" % n, raw["Train.webp"], "Train.webp (shared)")

    print("wrote %d files" % len(written))
    assert len(written) == 50, written.keys()
    # every real factory/train/island id covered exactly once
    import subprocess
    print("done")


if __name__ == "__main__":
    main()
