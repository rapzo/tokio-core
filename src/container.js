'use strict';

const wire = require('wire');
const Promise = require('bluebird');
const annotation = require('di/lib/annotation');
const Injector = require('di').Injector;
const Module = require('di').Module;
const Program = require('./program');

function Container(nodeModule) {
    this.program = new Program(nodeModule);
    this.pluginConfig = {};
    this.context = null;
    this.injector = null;
}

Container.prototype.addPlugin = function(name, impl) {
    this.pluginConfig[name] = impl;
};

Container.prototype.init = function (timeout) {

    // Execute the configuration hook
    this.program.configure()(this);

    return wire(this.pluginConfig)
        .timeout(
            Number(timeout),
            new Error('The context failed to boot in a timely fashion. Check your plugins and box connectivity')
        )
        .then((context) => {
            this.context = context;
        })
        .then(() => {
            const modules = [];
            let module = new Module();

            for (let pName in this.pluginConfig) {
                if (this.context[pName] instanceof Function) {
                    module.factory(pName, this.context[pName]);
                } else {
                    module.value(pName, this.context[pName]);
                }
            };
            modules.push(module);

            this.injector = new Injector(modules);

            // Decorate all Functions subject to Dependency Injection
            this.program.setup().$inject = annotation.parse(this.program.setup());
            this.program.teardown().$inject = annotation.parse(this.program.teardown());
            this.program.preconditions().$inject = annotation.parse(this.program.preconditions());
            this.program.main().$inject = annotation.parse(this.program.main());
            this.program.postconditions().$inject = annotation.parse(this.program.postconditions());

            // Execute the setup hook
            return this.injector.invoke(this.program.setup(), this.program);
        });
};

Container.prototype.destroy = function destroy() {
    if (!this.context) {
        return;
    }
    // TODO: onDestroy hook
    return this.context.destroy();
}

Container.prototype.log = function () {
    console.log.apply(console, arguments);
};

Container.prototype.execute = function execute(args) {
    return Promise.try(() => {
        const module = new Module();
        
        /**
         * Create servicing module.
         * This module contains data that *pertains* only to this execution,
         * hence, it is not shared with other executions.
         */
        for(let arg in args) {
            module.value(arg, args[arg]);
        }

        // if $require then $do then $ensure then END
        // if not $require then END
        // if $require then if not $do then END
        // if $require then $do then if not $ensure then END
        
        const executionVenue = this.injector
            // inherit from boot injector
            .createChild([module], Object.keys(this.pluginConfig));

        // inject dependencies and execute
        return Promise.try(() => {
            if (this.program.hasPreconditions()) {
                return executionVenue.invoke(this.program.preconditions());
            }
        })
        .then(() => {
            return executionVenue.invoke(this.program.main());
        })
        .then((outcome) => {
            module.value('$outcome', outcome);

            return Promise.try(() => {
                if (this.program.hasPostconditions()) {
                    return this.injector
                        .createChild([module], Object.keys(this.pluginConfig))
                        .invoke(this.program.postconditions());
                }
            })
            .then(() => outcome);
        });
    });
}

module.exports = Container;