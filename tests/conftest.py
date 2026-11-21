import importlib.util

collect_ignore_glob = [] if importlib.util.find_spec("pytest_homeassistant_custom_component") else ["integration/*"]
