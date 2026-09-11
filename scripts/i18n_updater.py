import json
import os
import sys
import argparse

def get_target_path(module_name, lang_code):
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    module_path = os.path.join(base_dir, module_name)
    if not os.path.exists(module_path):
        print(f"Warning: Module {module_name} does not exist at {module_path}. Falling back to 'entry'.")
        module_path = os.path.join(base_dir, 'entry')
    
    res_path = os.path.join(module_path, 'src', 'main', 'resources', lang_code, 'element', 'string.json')
    return res_path

def update_json(path, items, lang_key):
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = {"string": []}
    else:
        with open(path, 'r', encoding='utf-8') as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                print(f"Error: Could not decode JSON at {path}. Initializing new.")
                data = {"string": []}
            
    existing_keys = {item['name'] for item in data.get('string', [])}
    added_count = 0
    for item in items:
        if item['name'] not in existing_keys:
            value = item.get(lang_key)
            if value is not None:
                data.setdefault('string', []).append({"name": item['name'], "value": value})
                added_count += 1
            
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return added_count

def main():
    parser = argparse.ArgumentParser(description='Update i18n string.json files for HarmonyOS projects.')
    parser.add_argument('json_data', type=str, help='A JSON array string containing items like: [{"name":"key", "zh":"中文", "en":"English"}]')
    parser.add_argument('--module', type=str, default='entry', help='Target module name (default: entry)')
    args = parser.parse_args()

    try:
        items = json.loads(args.json_data)
        if not isinstance(items, list):
            print("Error: Input data must be a JSON array.")
            sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON data. {e}")
        sys.exit(1)

    base_path = get_target_path(args.module, 'base')
    en_path = get_target_path(args.module, 'en_US')

    zh_added = update_json(base_path, items, 'zh')
    en_added = update_json(en_path, items, 'en')

    print(f"Successfully updated i18n resources for module '{args.module}'.")
    print(f"Added {zh_added} keys to {base_path}")
    print(f"Added {en_added} keys to {en_path}")

if __name__ == '__main__':
    main()
