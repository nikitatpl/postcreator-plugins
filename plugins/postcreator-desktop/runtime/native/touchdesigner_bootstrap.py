"""Run inside an explicitly chosen TouchDesigner project via Textport.

Set POSTCREATOR_TD_CONFIG in this Python execution namespace to the path printed by setup.
Creates one new component; never replaces nodes or saves the user's .toe.
"""
import json, os
config = json.load(open(POSTCREATOR_TD_CONFIG, encoding='utf-8'))
root = op('/project1')
if root is None: raise RuntimeError('Expected /project1; open a new task-owned project')
if root.op('postcreator_bridge'): raise RuntimeError('Bridge already exists; inspect before replacing')
bridge = root.create(baseCOMP, 'postcreator_bridge')
try:
    bridge.store('postcreator_token',config['token'])
    bridge.store('postcreator_output_root',config['outputRoot'])
    workspace = bridge.create(baseCOMP,'workspace')
    callbacks = bridge.create(textDAT,'callbacks')
    callbacks.text = open(config['callbacks'],encoding='utf-8').read()
    server = bridge.create(webserverDAT,'server')
    server.par.localaddress = '127.0.0.1'
    server.par.port = config['port']
    server.par.callbacks = callbacks.path
    server.par.active = True
except Exception:
    bridge.destroy()
    raise
print('Postcreator loopback bridge ready at port ' + str(config['port']) + '; project has not been saved')
