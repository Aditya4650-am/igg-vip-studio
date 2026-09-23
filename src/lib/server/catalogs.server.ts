import { createHmac } from "node:crypto";
import { AVATAR_CHUNK, AVATAR_MAX, avatarGroupId, type Group, type Item, type StatField } from "@/lib/catalogs";
import { RAW_ITEMS, RAW_PROFILE, RAW_SKINS, type RawGroup } from "./catalogs.data.server";
import { DECOR_STASH } from "./township/decor-stash.server";
import { SKINS_CATALOG } from "./township/skins-catalog.server";
import { CHAT_EMOJI_IDS } from "./township/chat-emoji.server";

type Kind = "profile" | "skin" | "item" | "decor" | "stat" | "barn";

const PEPPER = Buffer.from("igg-vip-pub-id-v1");
const lookup = new Map<string, string>();

function pubId(kind: Kind, real: string) {
  const id = createHmac("sha256", PEPPER).update(`${kind}\0${real}`).digest("base64url").slice(0, 16);
  lookup.set(`${kind}:${id}`, real);
  return id;
}

function remapOne(kind: Kind, id: string) {
  return lookup.get(`${kind}:${id}`) ?? null;
}

const GROUP_META: Record<string, { label: string; emoji?: string }> = {
  Badges: { label: "Badges", emoji: "🏅" },
  ExpRanks: { label: "Titles / Ranks", emoji: "👑" },
  Frames: { label: "Frames", emoji: "🖼️" },
  Styles: { label: "Styles", emoji: "✨" },
  Themes: { label: "Themes", emoji: "🎨" },
  Fortress: { label: "Fortress", emoji: "🏰" },
  Pig: { label: "Pig", emoji: "🐷" },
  Cow: { label: "Cow", emoji: "🐮" },
  Train: { label: "Train", emoji: "🚂" },
  Ship: { label: "Ship", emoji: "🚢" },
  Airport: { label: "Airport", emoji: "🛫" },
  Harbor: { label: "Harbor", emoji: "⚓" },
  HelicopterPlace: { label: "Helicopter Pad", emoji: "🛟" },
  TrainStation: { label: "Station", emoji: "🚉" },
  Chicken: { label: "Chicken", emoji: "🐔" },
  Airplane: { label: "Airplane", emoji: "✈️" },
  Helicopter: { label: "Helicopter", emoji: "🚁" },
  Sheep: { label: "Sheep", emoji: "🐑" },
  Materials: { label: "Materials", emoji: "🧱" },
  Tools: { label: "Tools", emoji: "🔧" },
  "Match3 Boosts": { label: "Match-3 Boosts", emoji: "🎯" },
  Orders: { label: "Orders", emoji: "📦" },
  Gems: { label: "Gems", emoji: "💎" },
  Boosts: { label: "Boosts", emoji: "⚡" },
  Coupons: { label: "Coupons", emoji: "🎟️" },
};

function cloakGroup(kind: Kind, raw: RawGroup): Group {
  const meta = GROUP_META[raw.id] ?? { label: raw.id };
  return {
    id: raw.id,
    label: meta.label,
    emoji: meta.emoji,
    items: raw.items.map((it) => ({ id: pubId(kind, it.id), label: it.label })),
  };
}

const STAT_INTERNAL: { id: string; emoji: string; labelEn: string; labelVi: string }[] = [
  { id: "tca", emoji: "💎", labelEn: "T-Cash", labelVi: "T-Cash" },
  { id: "coi", emoji: "🪙", labelEn: "Coins", labelVi: "Xu" },
  { id: "lvl", emoji: "⭐", labelEn: "Level", labelVi: "Cấp" },
  { id: "dat", emoji: "📅", labelEn: "Start Date", labelVi: "Ngày bắt đầu" },
  { id: "win", emoji: "🏆", labelEn: "1st Place Wins", labelVi: "Số lần hạng 1" },
  { id: "liv", emoji: "❤️", labelEn: "Lives Sent", labelVi: "Mạng gửi" },
  { id: "reg", emoji: "🏁", labelEn: "Regatta", labelVi: "Regata" },
  { id: "hlp", emoji: "🤝", labelEn: "Help", labelVi: "Giúp đỡ" },
  { id: "exp", emoji: "⚡", labelEn: "Energy", labelVi: "Năng lượng" },
  { id: "key", emoji: "🔑", labelEn: "Keys", labelVi: "Chìa" },
  { id: "m3l", emoji: "🎯", labelEn: "Match-3 Level", labelVi: "Cấp Match-3" },
  { id: "match3Life", emoji: "🎮", labelEn: "Match-3 Lives", labelVi: "Mạng Match-3" },
  { id: "residents", emoji: "🏠", labelEn: "Residents", labelVi: "Dân số" },
  { id: "spentCash", emoji: "💸", labelEn: "Spent T-Cash", labelVi: "Đã tiêu $" },
  { id: "earnedCash", emoji: "💵", labelEn: "Earned T-Cash", labelVi: "Kiếm $" },
  { id: "EarnedCoins", emoji: "💰", labelEn: "Earned Coins", labelVi: "Kiếm xu" },
  { id: "wheatCounter", emoji: "🌾", labelEn: "Wheat", labelVi: "Lúa" },
  { id: "plowFieldsAchiev", emoji: "🚜", labelEn: "Fields Plowed", labelVi: "Ruộng đã cày" },
  { id: "defaultOrdersCount", emoji: "📦", labelEn: "Orders", labelVi: "Đơn hàng" },
  { id: "mineCounter", emoji: "⛏️", labelEn: "Mine", labelVi: "Mỏ" },
  { id: "timeInGame", emoji: "⏱️", labelEn: "Time in Game", labelVi: "Giờ chơi" },
  { id: "WareHouseCashUpgrade", emoji: "🏬", labelEn: "Warehouse Cash Upgrade", labelVi: "Nâng cấp kho $" },
  { id: "WHUdup", emoji: "🏬", labelEn: "Barn Capacity Code", labelVi: "Mã sức chứa kho" },
  { id: "Match3Lives_infTime", emoji: "♾️", labelEn: "Match-3 Infinite Lives", labelVi: "Match-3 mạng vô hạn" },
  { id: "xpr", emoji: "💫", labelEn: "Experience", labelVi: "Kinh nghiệm" },
  { id: "xpl", emoji: "🗺️", labelEn: "Town Expansions", labelVi: "Cấp mở rộng" },
  { id: "zxl", emoji: "🏝️", labelEn: "Zoo Expansions", labelVi: "Mở rộng sở thú" },
];

const BARN_INTERNAL: { id: string; label: string }[] = [
  { id: "wheat", label: "Wheat" },
  { id: "corn", label: "Corn" },
  { id: "carrot", label: "Carrot" },
  { id: "sugarcane", label: "Sugarcane" },
  { id: "milk", label: "Milk" },
  { id: "egg", label: "Egg" },
  { id: "wool", label: "Wool" },
  { id: "bread", label: "Bread" },
  { id: "cookie", label: "Cookie" },
  { id: "butter", label: "Butter" },
  { id: "cheese", label: "Cheese" },
  { id: "cotton", label: "Cotton" },
  { id: "fabric", label: "Fabric" },
  { id: "coat", label: "Coat" },
  { id: "paper", label: "Paper" },
  { id: "paint", label: "Paint" },
  { id: "clover", label: "Clover" },
  { id: "honey", label: "Honey" },
  // Extended warehouse products, inventoried from a decoded mGameInfo
  // (`*Counter` vars). Same plaintext-id mechanism, no new logic.
  { id: "accordion", label: "Accordion" },
  { id: "air_freshener", label: "Air Freshener" },
  { id: "airballoon", label: "Airballoon" },
  { id: "aloe", label: "Aloe" },
  { id: "aloeLeaves", label: "Aloe Leaves" },
  { id: "apple", label: "Apple" },
  { id: "applefresh", label: "Applefresh" },
  { id: "applejam", label: "Applejam" },
  { id: "appletea", label: "Appletea" },
  { id: "aromatic_oil", label: "Aromatic Oil" },
  { id: "arrabbiata", label: "Arrabbiata" },
  { id: "bacon", label: "Bacon" },
  { id: "bacon_eggs", label: "Bacon Eggs" },
  { id: "bagel", label: "Bagel" },
  { id: "baked_lobster", label: "Baked Lobster" },
  { id: "bakedpotatoes", label: "Bakedpotatoes" },
  { id: "ball", label: "Ball" },
  { id: "banana", label: "Banana" },
  { id: "bananabread", label: "Bananabread" },
  { id: "barbie", label: "Barbie" },
  { id: "basket", label: "Basket" },
  { id: "basketbouquet", label: "Basketbouquet" },
  { id: "bathrobeslippers", label: "Bathrobeslippers" },
  { id: "bed", label: "Bed" },
  { id: "beefeed", label: "Beefeed" },
  { id: "bigFeather", label: "Big Feather" },
  { id: "blacktea", label: "Blacktea" },
  { id: "book", label: "Book" },
  { id: "boots", label: "Boots" },
  { id: "bouillabaisse", label: "Bouillabaisse" },
  { id: "bridebouquet", label: "Bridebouquet" },
  { id: "BronzeBullion", label: "Bronze Bullion" },
  { id: "brownie", label: "Brownie" },
  { id: "bruschetta", label: "Bruschetta" },
  { id: "brush", label: "Brush" },
  { id: "burrito", label: "Burrito" },
  { id: "cacao", label: "Cacao" },
  { id: "canape", label: "Canape" },
  { id: "candy", label: "Candy" },
  { id: "candystick", label: "Candystick" },
  { id: "cappuccino", label: "Cappuccino" },
  { id: "caramel", label: "Caramel" },
  { id: "caramelapple", label: "Caramelapple" },
  { id: "carrot_hotdog", label: "Carrot Hotdog" },
  { id: "carrotcake", label: "Carrotcake" },
  { id: "catcave", label: "Catcave" },
  { id: "catlitter", label: "Catlitter" },
  { id: "cattoy", label: "Cattoy" },
  { id: "chair", label: "Chair" },
  { id: "cheese_coney", label: "Cheese Coney" },
  { id: "cheeseburger", label: "Cheeseburger" },
  { id: "cheesecake", label: "Cheesecake" },
  { id: "chickenfeed", label: "Chickenfeed" },
  { id: "chinadoll", label: "Chinadoll" },
  { id: "chips", label: "Chips" },
  { id: "chocobar", label: "Chocobar" },
  { id: "chocolate", label: "Chocolate" },
  { id: "chocolate_smoothie", label: "Chocolate Smoothie" },
  { id: "chocolatecake", label: "Chocolatecake" },
  { id: "clay", label: "Clay" },
  { id: "clothesline", label: "Clothesline" },
  { id: "coconut", label: "Coconut" },
  { id: "coconut_raf", label: "Coconut Raf" },
  { id: "coconutmacaroon", label: "Coconutmacaroon" },
  { id: "coffee", label: "Coffee" },
  { id: "coffeecake", label: "Coffeecake" },
  { id: "cold_tea", label: "Cold Tea" },
  { id: "cork", label: "Cork" },
  { id: "corkboard", label: "Corkboard" },
  { id: "corn_soup", label: "Corn Soup" },
  { id: "cornchips", label: "Cornchips" },
  { id: "corndog", label: "Corndog" },
  { id: "cottonCandy", label: "Cotton Candy" },
  { id: "cottonfabric", label: "Cottonfabric" },
  { id: "couch", label: "Couch" },
  { id: "cowfeed", label: "Cowfeed" },
  { id: "cream", label: "Cream" },
  { id: "creammask", label: "Creammask" },
  { id: "cupcake", label: "Cupcake" },
  { id: "custard", label: "Custard" },
  { id: "cutlery", label: "Cutlery" },
  { id: "diadem", label: "Diadem" },
  { id: "dispenser", label: "Dispenser" },
  { id: "dough", label: "Dough" },
  { id: "doughnut", label: "Doughnut" },
  { id: "downBoots", label: "Down Boots" },
  { id: "downFeather", label: "Down Feather" },
  { id: "downJacket", label: "Down Jacket" },
  { id: "dress", label: "Dress" },
  { id: "driedflowers", label: "Driedflowers" },
  { id: "driedMushrooms", label: "Dried Mushrooms" },
  { id: "drum", label: "Drum" },
  { id: "dumbbell", label: "Dumbbell" },
  { id: "duster", label: "Duster" },
  { id: "duvet", label: "Duvet" },
  { id: "earrings", label: "Earrings" },
  { id: "eraser", label: "Eraser" },
  { id: "eskimo", label: "Eskimo" },
  { id: "espresso", label: "Espresso" },
  { id: "eveningdress", label: "Eveningdress" },
  { id: "falafel", label: "Falafel" },
  { id: "featherEarrings", label: "Feather Earrings" },
  { id: "fish", label: "Fish" },
  { id: "fish_chips", label: "Fish Chips" },
  { id: "fishburger", label: "Fishburger" },
  { id: "flipflops", label: "Flipflops" },
  { id: "floor_lamp", label: "Floor Lamp" },
  { id: "flour", label: "Flour" },
  { id: "flowertub", label: "Flowertub" },
  { id: "flowerSoap", label: "Flower Soap" },
  { id: "frenchfries", label: "Frenchfries" },
  { id: "fried_fish", label: "Fried Fish" },
  { id: "frozenvegetables", label: "Frozenvegetables" },
  { id: "frozenyogurt", label: "Frozenyogurt" },
  { id: "fruitice", label: "Fruitice" },
  { id: "fruitjelly", label: "Fruitjelly" },
  { id: "frypan", label: "Frypan" },
  { id: "gardengnome", label: "Gardengnome" },
  { id: "gazpacho", label: "Gazpacho" },
  { id: "glazedbacon", label: "Glazedbacon" },
  { id: "gloves", label: "Gloves" },
  { id: "glue", label: "Glue" },
  { id: "GoldBullion", label: "Gold Bullion" },
  { id: "granola", label: "Granola" },
  { id: "grap_fizz", label: "Grap Fizz" },
  { id: "grapes", label: "Grapes" },
  { id: "grapes_jam", label: "Grapes Jam" },
  { id: "grilledMeat", label: "Grilled Meat" },
  { id: "guacamole", label: "Guacamole" },
  { id: "gyoza", label: "Gyoza" },
  { id: "handbag", label: "Handbag" },
  { id: "hat", label: "Hat" },
  { id: "heels", label: "Heels" },
  { id: "honeycake", label: "Honeycake" },
  { id: "honeycandy", label: "Honeycandy" },
  { id: "honeycomb", label: "Honeycomb" },
  { id: "hot_chocolate", label: "Hot Chocolate" },
  { id: "hot_dog", label: "Hot Dog" },
  { id: "hummus", label: "Hummus" },
  { id: "icecream", label: "Icecream" },
  { id: "irrigationhose", label: "Irrigationhose" },
  { id: "jalapeno", label: "Jalapeno" },
  { id: "jam", label: "Jam" },
  { id: "jasmine", label: "Jasmine" },
  { id: "jellybeans", label: "Jellybeans" },
  { id: "ketchup", label: "Ketchup" },
  { id: "kidsbag", label: "Kidsbag" },
  { id: "lasagna", label: "Lasagna" },
  { id: "lavender", label: "Lavender" },
  { id: "lei", label: "Lei" },
  { id: "lemon", label: "Lemon" },
  { id: "limepie", label: "Limepie" },
  { id: "lobster", label: "Lobster" },
  { id: "lobster_newburg", label: "Lobster Newburg" },
  { id: "lobster_nigiri", label: "Lobster Nigiri" },
  { id: "lollipop", label: "Lollipop" },
  { id: "lotionBottle", label: "Lotion Bottle" },
  { id: "lounge", label: "Lounge" },
  { id: "mango1", label: "Mango 1" },
  { id: "marinepizza", label: "Marinepizza" },
  { id: "marker", label: "Marker" },
  { id: "milkshake", label: "Milkshake" },
  { id: "mint", label: "Mint" },
  { id: "mintcake", label: "Mintcake" },
  { id: "mintchocolateicecream", label: "Mintchocolateicecream" },
  { id: "minticetea", label: "Minticetea" },
  { id: "mintlollipops", label: "Mintlollipops" },
  { id: "misosoup", label: "Misosoup" },
  { id: "mokachino", label: "Mokachino" },
  { id: "mole", label: "Mole" },
  { id: "muffin", label: "Muffin" },
  { id: "mug", label: "Mug" },
  { id: "mushroom", label: "Mushroom" },
  { id: "mushroom_jam", label: "Mushroom Jam" },
  { id: "mushroomPie", label: "Mushroom Pie" },
  { id: "mushroomSalad", label: "Mushroom Salad" },
  { id: "mushroomSoup", label: "Mushroom Soup" },
  { id: "mushroomfeed", label: "Mushroomfeed" },
  { id: "nachos", label: "Nachos" },
  { id: "newbackpack", label: "Newbackpack" },
  { id: "nicoise", label: "Nicoise" },
  { id: "nylonthread", label: "Nylonthread" },
  { id: "olive", label: "Olive" },
  { id: "oliveoil", label: "Oliveoil" },
  { id: "oolong", label: "Oolong" },
  { id: "pancake", label: "Pancake" },
  { id: "panpipe", label: "Panpipe" },
  { id: "papertowel", label: "Papertowel" },
  { id: "parfait", label: "Parfait" },
  { id: "peach", label: "Peach" },
  { id: "peach_jam", label: "Peach Jam" },
  { id: "peachyogurt", label: "Peachyogurt" },
  { id: "peanot_crepes", label: "Peanot Crepes" },
  { id: "peanut", label: "Peanut" },
  { id: "peanut_butter", label: "Peanut Butter" },
  { id: "pearl", label: "Pearl" },
  { id: "pearlneck", label: "Pearlneck" },
  { id: "pendant", label: "Pendant" },
  { id: "pepper", label: "Pepper" },
  { id: "perfumeBottle", label: "Perfume Bottle" },
  { id: "pettoy", label: "Pettoy" },
  { id: "pigfeed", label: "Pigfeed" },
  { id: "pillow", label: "Pillow" },
  { id: "pinata", label: "Pinata" },
  { id: "pine", label: "Pine" },
  { id: "pineapple", label: "Pineapple" },
  { id: "pineapplesorbet", label: "Pineapplesorbet" },
  { id: "pizza", label: "Pizza" },
  { id: "plastic", label: "Plastic" },
  { id: "Plasticine", label: "Plasticine" },
  { id: "plasticbottle", label: "Plastic Bottle" },
  { id: "PlatinumBullion", label: "Platinum Bullion" },
  { id: "plum", label: "Plum" },
  { id: "plum_jam", label: "Plum Jam" },
  { id: "plunger", label: "Plunger" },
  { id: "popcorn", label: "Popcorn" },
  { id: "potato", label: "Potato" },
  { id: "potatobread", label: "Potatobread" },
  { id: "potstand", label: "Potstand" },
  { id: "profiteroles", label: "Profiteroles" },
  { id: "puffedrice", label: "Puffedrice" },
  { id: "puppet", label: "Puppet" },
  { id: "quiche", label: "Quiche" },
  { id: "ragdoll", label: "Ragdoll" },
  { id: "ratatouille", label: "Ratatouille" },
  { id: "ravioli", label: "Ravioli" },
  { id: "readylunch", label: "Readylunch" },
  { id: "rice", label: "Rice" },
  { id: "rice_casserole", label: "Rice Casserole" },
  { id: "rice_noodle", label: "Rice Noodle" },
  { id: "ring", label: "Ring" },
  { id: "roseJam", label: "Rose Jam" },
  { id: "roseSeed", label: "Rose Seed" },
  { id: "roseSorbet", label: "Rose Sorbet" },
  { id: "rosetea", label: "Rosetea" },
  { id: "rubber", label: "Rubber" },
  { id: "rubberTree", label: "Rubber Tree" },
  { id: "saltedpeanut", label: "Saltedpeanut" },
  { id: "sandals", label: "Sandals" },
  { id: "sandwich", label: "Sandwich" },
  { id: "sauce", label: "Sauce" },
  { id: "saxophone", label: "Saxophone" },
  { id: "scallop", label: "Scallop" },
  { id: "scallopskew", label: "Scallopskew" },
  { id: "scallopsushi", label: "Scallopsushi" },
  { id: "seafood_salad", label: "Seafood Salad" },
  { id: "seafoodcocktail", label: "Seafoodcocktail" },
  { id: "seaweed", label: "Seaweed" },
  { id: "seaweedsalad", label: "Seaweedsalad" },
  { id: "sheepfeed", label: "Sheepfeed" },
  { id: "shelk", label: "Shelk" },
  { id: "shirt", label: "Shirt" },
  { id: "shrimp", label: "Shrimp" },
  { id: "shuttlecock", label: "Shuttlecock" },
  { id: "silk", label: "Silk" },
  { id: "silkfabric", label: "Silkfabric" },
  { id: "SilverBullion", label: "Silver Bullion" },
  { id: "sneakers", label: "Sneakers" },
  { id: "soapBubbles", label: "Soap Bubbles" },
  { id: "soup", label: "Soup" },
  { id: "soybean", label: "Soybean" },
  { id: "soymilk", label: "Soymilk" },
  { id: "strawberry", label: "Strawberry" },
  { id: "strawberry_jam", label: "Strawberry Jam" },
  { id: "strawberrycake", label: "Strawberrycake" },
  { id: "strudel", label: "Strudel" },
  { id: "sugar", label: "Sugar" },
  { id: "suit", label: "Suit" },
  { id: "suitcase", label: "Suitcase" },
  { id: "summerbouquet", label: "Summerbouquet" },
  { id: "sushi", label: "Sushi" },
  { id: "sweater", label: "Sweater" },
  { id: "sweetbouquet", label: "Sweetbouquet" },
  { id: "syrup", label: "Syrup" },
  { id: "table", label: "Table" },
  { id: "taco", label: "Taco" },
  { id: "teabush", label: "Teabush" },
  { id: "teacandies", label: "Teacandies" },
  { id: "teaceremonykit", label: "Teaceremonykit" },
  { id: "teacoffeebouquet", label: "Teacoffeebouquet" },
  { id: "teapot", label: "Teapot" },
  { id: "thai_sauce", label: "Thai Sauce" },
  { id: "tibettea", label: "Tibettea" },
  { id: "tiramisu", label: "Tiramisu" },
  { id: "tiroleanHat", label: "Tirolean Hat" },
  { id: "tissue", label: "Tissue" },
  { id: "toffee", label: "Toffee" },
  { id: "tofu", label: "Tofu" },
  { id: "tomat", label: "Tomat" },
  { id: "toolset", label: "Toolset" },
  { id: "toothpaste", label: "Toothpaste" },
  { id: "toys", label: "Toys" },
  { id: "tropical_mix", label: "Tropical Mix" },
  { id: "ukulele", label: "Ukulele" },
  { id: "vegancheesecake", label: "Vegancheesecake" },
  { id: "vegetablebouquet", label: "Vegetablebouquet" },
  { id: "vitamin_cocktail", label: "Vitamin Cocktail" },
  { id: "wallpapers", label: "Wallpapers" },
  { id: "waterbowl", label: "Waterbowl" },
  { id: "watermelon", label: "Watermelon" },
  { id: "watermelon_fresh", label: "Watermelon Fresh" },
  { id: "watermelon_jam", label: "Watermelon Jam" },
  { id: "weddingcake", label: "Weddingcake" },
  { id: "wheel", label: "Wheel" },
  { id: "whitetea", label: "Whitetea" },
  { id: "woolfabric", label: "Woolfabric" },
  { id: "yogurt", label: "Yogurt" },
];

/** Every genuine warehouse product id (classic + inventoried). */
export const BARN_PRODUCT_IDS: ReadonlySet<string> = new Set(BARN_INTERNAL.map((p) => p.id));

export const BARN_CAPACITY: { upgrades: number; capacity: number }[] = [
  { upgrades: 100, capacity: 5085 },
  { upgrades: 250, capacity: 16335 },
  { upgrades: 500, capacity: 35085 },
  { upgrades: 1000, capacity: 72585 },
  { upgrades: 2500, capacity: 185085 },
  { upgrades: 5000, capacity: 372585 },
  { upgrades: 8000, capacity: 597585 },
  { upgrades: 10000, capacity: 747585 },
];

function avatarGroups(): Group[] {
  const out: Group[] = [];
  for (let s = 1; s <= AVATAR_MAX; s += AVATAR_CHUNK) {
    const e = Math.min(s + AVATAR_CHUNK - 1, AVATAR_MAX);
    out.push({
      id: avatarGroupId(s),
      label: `Ava ${s}–${e}`,
      items: Array.from({ length: e - s + 1 }, (_, i) => {
        const n = s + i;
        return { id: String(n), label: `ava${n}` };
      }),
    });
  }
  return out;
}

const PROFILE: Group[] = RAW_PROFILE.filter((g) => g.id !== "Themes").map((g) => cloakGroup("profile", g));
const SKIN_LABELS = new Map<string, string>();
for (const g of RAW_SKINS) for (const it of g.items) SKIN_LABELS.set(it.id, it.label);

function skinLabel(id: string) {
  const known = SKIN_LABELS.get(id);
  if (known) return known;
  const raw = id.replace(/^Skin_/, "").replace(/_/g, " ");
  return raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
}

const SKINS: Group[] = Object.entries(SKINS_CATALOG).map(([id, available]) => ({
  id,
  label: GROUP_META[id]?.label ?? id,
  emoji: GROUP_META[id]?.emoji,
  items: available.split("|").filter(Boolean).map((sid) => ({ id: pubId("skin", sid), label: skinLabel(sid) })),
}));
const ITEMS: Group[] = RAW_ITEMS.map((g) => cloakGroup("item", g));
const AVATARS: Group[] = avatarGroups();
const DECOR: Item[] = DECOR_STASH.map((it) => ({ id: pubId("decor", it.id), label: it.label }));
const EMOJI: Item[] = CHAT_EMOJI_IDS.map((id) => ({
  id,
  label: id.startsWith("sp")
    ? `Special Sticker ${id.slice(2)}`
    : id.startsWith("st")
      ? `Sticker ${id.slice(2)}`
      : id.startsWith("v")
        ? `VIP Sticker ${id.slice(1)}`
        : `Sticker ${id}`,
}));
const FIELDS: StatField[] = STAT_INTERNAL.map((f) => ({
  ...f,
  key: f.id,
  id: pubId("stat", f.id),
}));
const BARN_PRODUCTS: Item[] = BARN_INTERNAL.map((p) => ({
  id: p.id,
  label: p.label,
}));

// Pre-warm the public-id lookup at module load time. The app runs in a server
// process where requests must not depend on a previous catalog request having
// populated the in-memory map.
for (const g of RAW_PROFILE) for (const it of g.items) pubId("profile", it.id);
for (const g of RAW_SKINS) for (const it of g.items) pubId("skin", it.id);
for (const g of RAW_ITEMS) for (const it of g.items) pubId("item", it.id);
for (const it of DECOR_STASH) pubId("decor", it.id);
for (const f of STAT_INTERNAL) pubId("stat", f.id);
for (const p of BARN_INTERNAL) pubId("barn", p.id);

export function publicCatalogs() {
  return {
    profile: PROFILE,
    avatars: AVATARS,
    skins: SKINS,
    items: ITEMS,
    decor: DECOR,
    emoji: EMOJI,
    fields: FIELDS,
    barnCapacity: BARN_CAPACITY,
    barnProducts: BARN_PRODUCTS,
    avatarMax: AVATAR_MAX,
  };
}

function remapRecord<T>(kind: Kind, rec: Record<string, T> | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (!rec) return out;
  for (const [k, v] of Object.entries(rec)) {
    const real = remapOne(kind, k);
    if (real) out[real] = v;
  }
  return out;
}

function remapGroups(kind: Kind, rec: Record<string, string[]> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!rec) return out;
  for (const [g, ids] of Object.entries(rec)) {
    const mapped = ids.map((id) => remapOne(kind, id)).filter((x): x is string => Boolean(x));
    if (mapped.length) out[g] = mapped;
  }
  return out;
}

export function revealSave(p: {
  stats?: Record<string, string>;
  profile?: Record<string, string[]>;
  avatars?: string[];
  skins?: Record<string, string[]>;
  items?: Record<string, number>;
  decor?: string[];
  barnItems?: Record<string, number>;
  museum?: string[];
  cards?: Record<string, number>;
  zoo?: string[];
}) {
  return {
    stats: remapRecord("stat", p.stats),
    profile: remapGroups("profile", p.profile),
    avatars: (p.avatars ?? []).filter((id) => /^\d+$/.test(id)),
    museum: (p.museum ?? []).filter((id) => /^a\d+$/.test(id)),
    cards: Object.fromEntries(
      Object.entries(p.cards ?? {}).filter(([id]) => /^card_0*\d+$/.test(id)),
    ),
    zoo: (p.zoo ?? []).filter((id) => /^[^:]+:\d+$/.test(id)),
    skins: remapGroups("skin", p.skins),
    items: remapRecord("item", p.items),
    decor: (p.decor ?? []).map((id) => remapOne("decor", id)).filter((x): x is string => Boolean(x)),
    barnItems: p.barnItems ?? {},
  };
}

export function cloakProfileUnlocked(unlocked: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [group, ids] of Object.entries(unlocked)) {
    const mapped = ids.map((id) => pubId("profile", id));
    if (mapped.length) out[group] = mapped;
  }
  return out;
}

export function cloakStats(stats: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of STAT_INTERNAL) {
    const pub = pubId("stat", f.id);
    if (stats[f.id] !== undefined) out[pub] = stats[f.id];
  }
  return out;
}

export function cloakBarnItems(items: Record<string, number>): Record<string, number> {
  // Barn product ids are intentionally kept as plaintext IDs. This matches the
  // v1.15 app, where the warehouse list is meant to show the actual product key
  // and not an opaque public id.
  return { ...items };
}

export function demoBarnItems(): Record<string, number> {
  const items: Record<string, number> = {};
  const seed = [48, 36, 22, 18, 40, 28, 16, 12, 9, 7, 6, 14, 8, 3, 11, 5, 20, 4];
  BARN_INTERNAL.forEach((p, i) => {
    items[p.id] = seed[i] ?? 10;
  });
  return items;
}
