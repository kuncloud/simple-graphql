// @flow
const Sequelize = require('sequelize')
const relay = require('graphql-relay')
const _ = require('lodash')
const {
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLFloat,
  GraphQLID,
  GraphQLString,
  responsePathAsArray
} = require('graphql')
const camelcase = require('camelcase')
const DataLoader = require('dataloader')
const parseFields = require('graphql-parse-fields')

const StringHelper = require('./utils/StringHelper')
const invariant = require('./utils/invariant')
const Transformer = require('./transformer')
const {mergeNQueryBulk} = require('./sequelize/mergeNQuery')
const SequelizeContext = require('./sequelize/SequelizeContext')
const {buildBindings} = require('./utils/remote')
const helper = require('./utils/helper')

module.exports = class Context {

  constructor (sequelize, options, remoteCfg) {
    this.dbContext = new SequelizeContext(sequelize)
    this.options = {
      dataLoader: true,
      remoteLoader: true
    }
    _.assign(this.options, options)

    this.dbModels = {}
    this.schemas = {}
    this.services = {}
    this.graphQLObjectTypes = {}
    this.queries = {}
    this.mutations = {}
    this.subscriptions = {}
    this.loaders = {}
    this.schemasFieldsAndLinks = {}

    this.connectionDefinitions = {}

    const self = this
    this.nodeInterface = relay.nodeDefinitions((globalId) => {
      var {type, id} = relay.fromGlobalId(globalId)
      console.log('Warning-------------------- node id Fetcher not implement' + type + ' ' + id)
    }, (obj) => {
      const type = obj._type
      return self.graphQLObjectTypes[type]
    }).nodeInterface

    this.resolvers = {
      Query: {},
      Mutation: {}
    }

    this.remoteInfo = buildBindings(remoteCfg, {headerKeys: options.headerKeys})
    this.remotePrefix = '_remote_'
    // 暂时只开启一个remoteLoader，可考虑开启多个
    this.remoteLoader = this.options.remoteLoader !== false ? this.initRemoteLoader() : null

    this.getSGContext = (function () {
      let unique
      function getInstance() {
        if (!unique) {
          unique = SGContext(this)
        }
        return unique
      }
      function SGContext(self) {
        return {
          sequelize: self.dbContext.sequelize,
          loaders: self.loaders,
          remoteLoader: self.remoteLoader,
          dataLoader: self.options.dataLoader,
          models: self.dbModels,
          services: _.mapValues(self.services, (service) => service.config.statics),
          bindings: {
            toGId: (type, id) => relay.toGlobalId(type, id),
            toDbId: (type, id) => {
              const gid = relay.fromGlobalId(id)
              if (gid.type !== type) {
                throw new Error(`错误的global id,type:${type},gid:${id}`)
              }
              return gid.id
            },
            ...self.remoteInfo['binding']
          },
          getTargetBinding: (modeName) => {
            if (!self.remoteInfo['schema']) {
              return
            }

            let target
            _.forOwn(self.remoteInfo['schema'], (value, key) => {
              if (value && value.getType(modeName)) {
                target = key
                return false
              }
            })

            return target ? self.remoteInfo['binding'][target] : null
          }
        }
      }
      return getInstance
    })()
  }

  getTargetSchema (modeName) {
    if (!this.remoteInfo['schema']) {
      return
    }

    let target = {
      schema: null,
      type: null
    }
    _.forOwn(this.remoteInfo['schema'], (value, key) => {
      let type = value && value.getType(modeName)
      if (type) {
        if (target && target.type) {
          if (helper.calcRemoteLevels(target.type.description) > helper.calcRemoteLevels(type.description)) {
            target.schema = value
            target.type = type
          }
        } else {
          target.schema = value
          target.type = type
        }
      } else {
        // console.error('getTargetSchema:',modeName,key,type.name,type.description)
      }
    })

    return target.schema
  }

  addRemoteResolver (schemaName, fieldName, linkId, target) {
    if (!this.resolvers[schemaName]) {
      this.resolvers[schemaName] = {}
    }
    // console.log('addRemoteResolver:',schemaName,fieldName,linkId,target)
    const self = this
    this.resolvers[schemaName][fieldName] = {
      fragment: `... on ${schemaName} { ${linkId} }`,
      resolve: (root, args, context, info) => {
        const targetSchema = self.getTargetSchema(target)
        if (_.isEmpty(targetSchema)) {
          console.error(`addRemoteResolver:can't find remote object ${target} in schema ${schemaName}:${fieldName}`)
          return root[fieldName]
        }

        const fn = self.wrapFieldResolve({
          name: fieldName,
          path: fieldName,
          $type: self.remoteGraphQLObjectType(target),
          resolve: async function (root, args, context, info, sgContext) {
            if (!root) return

            const id = root[linkId]
            if (id === undefined) { return null }
            if (typeof id === 'object' && id === null) { return null }// db 对应字段为null

            if (context.qid && mergeNQueryBulk[context.qid]) {
              // const apiName = helper.pluralQueryName(target)
              const pathArr = responsePathAsArray(info.path)
              const skipIndex = pathArr.length - 3 // eg: [ 'patients', 'edges', 0, 'node', 'city' ] 去掉0，与mergeNQuery的path一致
              // invariant(skipIndex > 0, 'err path:', pathArr)
              if (skipIndex > 0) {
                // console.log('path arr:', context.qid,pathArr,mergeNQueryBulk[context.qid])
                let path = pathArr[0]
                for (let i = 1; i < pathArr.length; ++i) {
                  if (i === skipIndex) { continue }
                  path = helper.contactPath(path, pathArr[i])
                }

                const queryContext = mergeNQueryBulk[context.qid] && mergeNQueryBulk[context.qid][path]
                // console.log('addRemoteResolver', context.qid,id, path, queryContext)
                if (queryContext && queryContext.fn) {
                  const res = queryContext.fn(target, id, queryContext)
                  // if (_.isEmpty(Object.keys(queryContext))) {
                  //   delete mergeNQueryBulk[context.qid][path]
                  //   if (_.isEmpty(Object.keys(mergeNQueryBulk[context.qid]))) {
                  //     delete mergeNQueryBulk[context.qid]
                  //   }
                  // }
                  if (res) {
                    return res
                  }
                }
              }
            }

            if (root && id && (
                typeof id === 'number' ||
                typeof id === 'string'
              )) {
              if (self.remoteLoader && self.options.remoteLoader !== false) {
                return self.remoteLoader.load({id, info, target, context})
              }
              return info.mergeInfo.delegateToSchema({
                schema: targetSchema,
                operation: 'query',
                fieldName: StringHelper.toInitialLowerCase(target),
                args: {
                  id: id
                },
                context,
                info
              })
              // console.log('context.addResolver:',res)
            } else {
              // throw new Error('Must provide linkId',linkId,schema.name)
            }

            return root[fieldName]
          }
        })

        return fn(root, args, context, info)
      }
    }
  }

  addSchema (schema) {
    if (this.schemas[schema.name]) {
      throw new Error('Schema ' + schema.name + ' already define.')
    }
    if (this.services[schema.name]) {
      throw new Error('Schema ' + schema.name + ' conflict with Service ' + schema.name)
    }
    if (schema.name.length >= 1 && (schema.name[0] === '_' || schema.name.endsWith('Id'))) {
      throw new Error(`Schema "${schema.name}" must not begin with "_" or end with "Id", which is reserved by MGS`)
    }
    if (!schema.config.description && schema.config.description.startsWith('__')) {
      throw new Error(`Schema "${schema.name}" description must not begin with "__"  which is reserved by MGS`)
    }

    this.schemas[schema.name] = schema

    this.dbContext.applyPlugin(schema)

    schema.fields({
      createdAt: {
        $type: Date,
        initializable: false,
        mutable: false
      },
      updatedAt: {
        $type: Date,
        initializable: false,
        mutable: false
      }
    })

    if (schema.config.options && schema.config.options.table && schema.config.options.table.paranoid) {
      schema.fields({
        deletedAt: {
          $type: Date,
          initializable: false
        }
      })
    }

    _.forOwn(schema.config.queries, (value, key) => {
      if (!value['name']) {
        value['name'] = key
      }
      this.addQuery(value)
    })

    _.forOwn(schema.config.mutations, (value, key) => {
      if (!value['name']) {
        value['name'] = key
      }
      this.addMutation(value)
    })

    _.forOwn(schema.config.subscriptions, (value, key) => {
      if (!value['name']) {
        value['name'] = key
      }
      this.addSubscription(value)
    })

    this.dbModel(schema.name)

    // 添加loader
    if (this.options.dataLoader !== false) this.loaders[schema.name] = this.initLoader(schema.name)
  }

  addService (service) {
    const self = this
    if (self.services[service.name]) {
      throw new Error('Service ' + service.name + ' already define.')
    }
    if (self.schemas[service.name]) {
      throw new Error('Service ' + service.name + ' conflict with Schema ' + service.name)
    }
    service.statics({
      getSGContext: () => self.getSGContext()
    })
    self.services[service.name] = service

    _.forOwn(service.config.queries, (value, key) => {
      if (!value['name']) {
        value['name'] = key
      }
      self.addQuery(value)
    })

    _.forOwn(service.config.mutations, (value, key) => {
      if (!value['name']) {
        value['name'] = key
      }
      self.addMutation(value)
    })
  }

  addQuery (config) {
    if (this.queries[config.name]) {
      throw new Error('Query ' + config.name + ' already define.')
    }
    this.queries[config.name] = config
  }

  addMutation (config) {
    if (this.mutations[config.name]) {
      throw new Error('Mutation ' + config.name + ' already define.')
    }
    this.mutations[config.name] = config
  }

  addSubscription (config) {
    if (this.subscriptions[config.name]) {
      throw new Error('Subscription ' + config.name + ' already define.')
    }
    this.subscriptions[config.name] = config
  }

  remoteGraphQLObjectType (name) {
    // console.log('Context.remoteGraphQLObjectType',name)
    const typeName = this.remotePrefix + name
    if (!this.graphQLObjectTypes[typeName]) {
      const objectType = new GraphQLObjectType({
        name: typeName,
        fields: {
          'id': {
            type: GraphQLString,
            resolve: () => {
              return 'MGS only fake ,not supported'
            }
          }
        }, // TODO support arguments
        description: JSON.stringify({
          target: name
        })
      })
      this.graphQLObjectTypes[typeName] = objectType
    }
    return this.graphQLObjectTypes[typeName]
  }

  getFieldsAndLinks (model, name) {

    const schemaFieldsAndLinks = this.schemasFieldsAndLinks[name]
    if (schemaFieldsAndLinks) {
      return schemaFieldsAndLinks
    }

    const obj = {}
    Object.assign(obj, model.config.fields, model.config.links)
    obj.id = {
      $type: new GraphQLNonNull(GraphQLID),
      resolve: async function (root) {
        return relay.toGlobalId(StringHelper.toInitialUpperCase(model.name), root.id)
      }
    }
    this.schemasFieldsAndLinks[name] = obj
    return obj

  }

  graphQLObjectType (name) {
    const model = this.schemas[name]
    if (!model) {
      throw new Error('Schema ' + name + ' not define.')
    } else {
      invariant(model.name === name, `${model.name}与${name}不一致`)
    }
    const typeName = name

    if (!this.graphQLObjectTypes[typeName]) {
      const interfaces = [this.nodeInterface]
      const objectType = Transformer.toGraphQLFieldConfig(typeName, '', this.getFieldsAndLinks(model, name), this, interfaces, true).type
      if (objectType instanceof GraphQLObjectType) {
        objectType.description = model.config.options.description
        this.graphQLObjectTypes[typeName] = objectType
      } else {
        invariant(false, `wrong model format:${name}`)
      }
    }
    return this.graphQLObjectTypes[typeName]
  }

  dbModel (name) {
    const model = this.schemas[name]
    if (!model) {
      throw new Error('Schema ' + name + ' not define.')
    }
    const typeName = model.name
    const self = this
    if (!self.dbModels[typeName]) {
      self.dbModels[typeName] = self.dbContext.define(model)

      Object.assign(self.dbModels[typeName], model.config.statics)
      Object.assign(self.dbModels[typeName].prototype, model.config.methods)
    }
    return self.dbModels[typeName]
  }

  initLoader (name) {
    const model = this.dbModels[name]
    return new DataLoader(async(ids) => {
      const lists = await model.findAll({
        where: {
          id: {
            [Sequelize.Op.in]: ids
          }
        }
      })
      const temp = {}
      lists.map(item => {
        temp[item.id] = item
      })

      return ids.map(id => temp[id])
    }, {
      cache: false
    })
  }

  /**
   * 当一个请求有多个remote时，分别组织参数
   * @param options
   */
  parseRemoteTarget (options) {
    const targets = {}
    const self = this

    if (options) {
      options.map(({id, info, context}) => {
        const target = info.fieldName
        const aliasMap = {}
        self.findAliasField(info, aliasMap, '')
        if (_.keys(targets).indexOf(target) === -1) {
          _.assign(targets, {
            [target]: {
              ids: [],
              info,
              // 默认传递id，防止前端不传id导致下面匹配不上
              parsedInfo: {id: true},
              aliasMap,
              context
            }
          })
        }

        if (_.keys(targets).indexOf(target) >= 0) {
          targets[target].ids.push(id)
          targets[target].parsedInfo = self.analysisInfo(targets[target].parsedInfo, info)
          targets[target].aliasMap = _.assign(targets[target].aliasMap, aliasMap)
        }
      })
    }
    return targets
  }

  // 将所有同类型的字段合并，防止一个请求取同类型不同字段出现报错。如{id, name} {id, code}
  analysisInfo (parsed, newInfo) {
    const newParsed = parseFields(newInfo)
    return _.merge(parsed, newParsed)
  }

  // 对id做简单处理，防止一个请求中clinic{id}和getClinic{id, name}匹配错乱问题
  encryptId (id, target) {
    return `${id}-${target}`
  }

  recursionSetAlias(obj, aliasFields, fields, index = 0) {
    if (obj === null || obj === undefined) {
      return true
    }
    if (Array.isArray(obj)) {
      for (let o of obj) {
        this.recursionSetAlias(o, aliasFields, fields, index)
      }
      return true
    }
    if (fields.length - 1 === index) {
      obj[aliasFields[index]] = obj[fields[index]]
      return true
    }
    const subObj = obj[fields[index]]
    this.recursionSetAlias(subObj, aliasFields, fields, index + 1)
  }

  joinKey(root, key) {
    if (root) {
      return root + '.' + key
    }
    return key
  }

  findAliasField (info, aliasMap, key = '', isFieldNode = false) {
    if (info.fieldNodes) {
      for (let fieldNode of info.fieldNodes) {
        this.findAliasField(fieldNode, aliasMap, key, true)
      }
    } else {
      const newKey = this.joinKey(key, info.name.value)
      if (info.alias) {
        aliasMap[this.joinKey(key, info.alias.value)] = newKey
      }
      if (info.selectionSet && info.selectionSet.selections) {
        for (let selection of info.selectionSet.selections) {
          this.findAliasField(selection, aliasMap, isFieldNode ? '' : newKey)
        }
      }
    }
  }

  // 把有别名的字段设置（还原）回去
  setAliasFieldValue (aliasMap, node) {
    for (let [aliasName, fieldName] of Object.entries(aliasMap)) {
      const fields = fieldName.split('.')
      const aliasFields = aliasName.split('.')
      this.recursionSetAlias(node, aliasFields, fields)
    }
  }

  initRemoteLoader () {
    const self = this
    return new DataLoader(async(options) => {
      const targets = self.parseRemoteTarget(options)
      const encryptIds = options.map(o => self.encryptId(o.id, o.info.fieldName))
      const temp = {}

      for (let target in targets) {
        const {ids, info, parsedInfo, aliasMap, context} = targets[target]
        let strInfo = JSON.stringify(parsedInfo).replace(/"/g, '').replace(/:true/g, '').replace(/:{/g, '{')

        const type = info.returnType.name
        const binding = this.getSGContext().getTargetBinding(type)
        if (!binding) return []
        // 优先使用get${modelName}sByIds
        const distinctIds = [...new Set(ids)]
        if (binding.query[`get${type}sByIds`]) {
          const res = await binding.query[`get${type}sByIds`]({
            ids: distinctIds
          }, strInfo, { context })
          for (let node of res) {
            self.setAliasFieldValue(aliasMap, node)
            temp[self.encryptId(node.id, target)] = node
          }
        } else {
          const res = await binding.query[StringHelper.toInitialLowerCase(type) + 's'](
            {
              first: distinctIds.length,
              options: {
                where: {
                  id: {
                    in: distinctIds
                  }
                }
              }
            },
            `{edges{node${strInfo}}}`,
            { context }
          )
          res.edges.map(({node}) => {
            self.setAliasFieldValue(aliasMap, node)
            temp[self.encryptId(node.id, target)] = node
          })
        }
      }
      return encryptIds.map(encryptId => temp[encryptId])
    }, {
      cache: false
    })
  }

  wrapQueryResolve (config) {
    const self = this
    const {handleError} = this.options

    let hookFun = async (action, invokeInfo, next) => {
      try {
        return await next()
      } catch (e) {
        if (handleError) {
          handleError(e)
        } else {
          throw e
        }
      }
    }

    if (this.options.hooks != null) {
      this.options.hooks.reverse().forEach(hook => {
        if (!hook.filter || hook.filter({type: 'query', config})) {
          const preHook = hookFun
          hookFun = (action, invokeInfo, next) => hook.hook(action, invokeInfo, preHook.bind(null, action, invokeInfo, next))
        }
      })
    }

    return (source, args, context, info) => hookFun({
      type: 'query',
      config: config
    }, {
      source: source,
      args: args,
      context: context,
      info: info,
      sgContext: self.getSGContext()
    },
      () => {
        return config.resolve(args, context, info, self.getSGContext())
      }
    )
  }

  wrapSubscriptionResolve (config) {
    const self = this

    const {handleError} = this.options

    let hookFun = async (action, invokeInfo, next) => {
      try {
        return await next()
      } catch (e) {
        if (handleError) {
          handleError(e)
        } else {
          throw e
        }
      }
    }

    if (this.options.hooks != null) {
      this.options.hooks.reverse().forEach(hook => {
        if (!hook.filter || hook.filter({type: 'subscription', config})) {
          const preHook = hookFun
          hookFun = (action, invokeInfo, next) => hook.hook(action, invokeInfo, preHook.bind(null, action, invokeInfo, next))
        }
      })
    }

    return (source, args, context, info) => hookFun({
      type: 'subscription',
      config: config
    }, {
      source: source,
      args: args,
      context: context,
      info: info,
      sgContext: self.getSGContext()
    },
      () => {
        return config.resolve(source, args, context, info, self.getSGContext())
      }
    )
  }

  wrapFieldResolve (config) {
    const self = this

    let hookFun = (action, invokeInfo, next) => next()
    if (this.options.hooks != null) {
      this.options.hooks.reverse().forEach(hook => {
        if (!hook.filter || hook.filter({type: 'field', config})) {
          const preHook = hookFun
          hookFun = (action, invokeInfo, next) => hook.hook(action, invokeInfo, preHook.bind(null, action, invokeInfo, next))
        }
      })
    }

    return (source, args, context, info) => hookFun({
      type: 'field',
      config: config
    }, {
      source: source,
      args: args,
      context: context,
      info: info,
      sgContext: self.getSGContext()
    },
      () => config.resolve(source, args, context, info, self.getSGContext())
    )
  }

  wrapMutateAndGetPayload (config) {
    const self = this

    const {handleError} = this.options

    let hookFun = async (action, invokeInfo, next) => {
      try {
        return await next()
      } catch (e) {
        if (handleError) {
          handleError(e)
        } else {
          throw e
        }
      }
    }

    if (this.options.hooks != null) {
      this.options.hooks.reverse().forEach(hook => {
        if (!hook.filter || hook.filter({type: 'mutation', config})) {
          const preHook = hookFun
          hookFun = (action, invokeInfo, next) => hook.hook(action, invokeInfo, preHook.bind(null, action, invokeInfo, next))
        }
      })
    }

    return (args, context, info) => hookFun({
      type: 'mutation',
      config: config
    }, {
      args: args,
      context: context,
      info: info,
      sgContext: self.getSGContext()
    },
      () => config.mutateAndGetPayload(args, context, info, self.getSGContext())
    )
  }

  connectionDefinition (schemaName) {
    if (!this.connectionDefinitions[schemaName]) {
      this.connectionDefinitions[schemaName] = relay.connectionDefinitions({
        name: StringHelper.toInitialUpperCase(schemaName),
        nodeType: this.graphQLObjectType(schemaName),
        connectionFields: {
          count: {
            type: GraphQLFloat
          }
        }
      })
    }
    return this.connectionDefinitions[schemaName]
  }

  connectionType (schemaName) {
    return this.connectionDefinition(schemaName).connectionType
  }

  edgeType (schemaName) {
    return this.connectionDefinition(schemaName).edgeType
  }

  buildModelAssociations () {
    const self = this
    _.forOwn(self.schemas, (schema) => {
      _.forOwn(schema.config.associations.hasMany, (config, key) => {
        config.foreignKey = {
          name: camelcase(config.foreignKey || config.foreignField + 'Id'),
          field: config.foreignKey || config.foreignField + 'Id'
        }
        config.as = key
        self.dbModel(schema.name).hasMany(self.dbModel(config.target), config)
      })
      _.forOwn(schema.config.associations.belongsToMany, (config, key) => {
        config.through && (config.through.model = self.dbModel(config.through.model))
        config.as = key
        config.foreignKey = config.foreignKey || config.foreignField + 'Id'

        self.dbModel(schema.name).belongsToMany(self.dbModel(config.target), config)
      })
      _.forOwn(schema.config.associations.hasOne, (config, key) => {
        config.as = key
        config.foreignKey = {
          name: camelcase(config.foreignKey || config.foreignField + 'Id'),
          field: config.foreignKey || config.foreignField + 'Id'
        }
        self.dbModel(schema.name).hasOne(self.dbModel(config.target), config)
      })
      _.forOwn(schema.config.associations.belongsTo, (config, key) => {
        config.as = key
        config.foreignKey = config.foreignKey || config.foreignField + 'Id'
        self.dbModel(schema.name).belongsTo(self.dbModel(config.target), config)
      })
    })
  }
}
